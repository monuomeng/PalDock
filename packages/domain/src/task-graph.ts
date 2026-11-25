import { MAX_PLAN_NODES, NODE_KEY_PATTERN, TASK_STATUSES, type GraphNode, type PlanNodeInput, type SubtaskStatus, type TaskStatus } from '@paldock/contracts';
import { DomainError } from './errors.js';
import { taskMachine } from './state-machine.js';

/**
 * 任务图的纯规则：计划校验、按依赖推进子任务、由子任务推导任务状态。存储与执行都不在这里。
 */

/** 拓扑排序（Kahn）；有环时返回环上（含被环挡住）的节点。 */
function topoOrder<T>(items: readonly T[], key: (item: T) => string, deps: (item: T) => readonly string[]): { order: T[]; stuck: T[] } {
  const byKey = new Map(items.map((item) => [key(item), item]));
  const pending = new Map(items.map((item) => [key(item), deps(item).filter((d) => byKey.has(d)).length]));
  const dependents = new Map<string, string[]>();
  for (const item of items) for (const d of deps(item)) if (byKey.has(d)) dependents.set(d, [...(dependents.get(d) ?? []), key(item)]);
  const ready = items.filter((item) => pending.get(key(item)) === 0);
  const order: T[] = [];
  while (ready.length > 0) {
    const item = ready.shift()!;
    order.push(item);
    for (const next of dependents.get(key(item)) ?? []) {
      const left = pending.get(next)! - 1;
      pending.set(next, left);
      if (left === 0) ready.push(byKey.get(next)!);
    }
  }
  const placed = new Set(order);
  return { order, stuck: items.filter((item) => !placed.has(item)) };
}

/** 项目内相对路径（可以带 glob）：拒绝绝对路径、盘符、`~` 和任何 `..` 段。 */
export function pathProblem(path: string): string | undefined {
  if (/^[\\/]/.test(path) || /^[a-zA-Z]:/.test(path)) return `不能用绝对路径：${path}`;
  if (path.startsWith('~')) return `不能用主目录路径：${path}`;
  if (path.split(/[\\/]/).includes('..')) return `不能用 .. 跳出项目目录：${path}`;
  return undefined;
}

/**
 * 计划校验（提议和确认时各做一次）：节点数、节点键、角色、依赖引用、无环、路径。
 * knownRoles 是可以派单的角色（设置里有的，不含协调助手）。不通过时抛 bad_request，列出全部问题。
 */
export function validatePlan(nodes: readonly PlanNodeInput[], knownRoles: ReadonlySet<string>): void {
  const problems: string[] = [];
  if (nodes.length === 0) problems.push('计划至少要有一个子任务');
  if (nodes.length > MAX_PLAN_NODES) problems.push(`子任务最多 ${MAX_PLAN_NODES} 个，现在有 ${nodes.length} 个`);
  const keys = new Set<string>();
  for (const node of nodes) {
    if (!NODE_KEY_PATTERN.test(node.key)) problems.push(`节点键不合法：${node.key}`);
    if (keys.has(node.key)) problems.push(`节点键重复：${node.key}`);
    keys.add(node.key);
    if (!knownRoles.has(node.role)) problems.push(`${node.key}：没有角色 ${node.role}`);
    for (const path of node.paths) {
      const problem = pathProblem(path);
      if (problem) problems.push(`${node.key}：${problem}`);
    }
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.key) problems.push(`${node.key}：不能依赖自己`);
      else if (!keys.has(dep)) problems.push(`${node.key}：依赖的节点 ${dep} 不在计划里`);
    }
  }
  const { stuck } = topoOrder(nodes, (n) => n.key, (n) => n.dependsOn.filter((d) => d !== n.key));
  if (stuck.length > 0) problems.push(`依赖有环：${stuck.map((n) => n.key).join('、')}`);
  if (problems.length > 0) throw new DomainError('bad_request', `计划不合法：${problems.join('；')}`);
}

const UPSTREAM_TROUBLE: Partial<Record<SubtaskStatus, string>> = { failed: '失败', blocked: '阻塞', cancelled: '已取消' };
const UPSTREAM_PREFIX = '上游「';

/** 因上游出问题而阻塞的原因；graphStep 靠这个前缀认出可以自动解除的阻塞。 */
export const upstreamBlockReason = (title: string, status: SubtaskStatus) => `${UPSTREAM_PREFIX}${title}」${UPSTREAM_TROUBLE[status] ?? status}`;
const blockedByUpstream = (node: GraphNode) => node.status === 'blocked' && (node.statusReason?.startsWith(UPSTREAM_PREFIX) ?? false);

export interface GraphChange {
  id: string;
  from: SubtaskStatus;
  to: SubtaskStatus;
  reason?: string;
}

/**
 * 一个任务图当前该做的状态变化，按拓扑顺序一次算完（链式阻塞、链式解除在同一步里）：
 * - 等依赖的：依赖都成功 → 排队；有依赖失败 / 阻塞 / 取消 → 阻塞并写明是哪个上游；
 * - 因上游而阻塞的：上游都恢复正常后回到等依赖（依赖都成功则直接排队）；
 * 因自身失败或服务重启而阻塞的不动，由用户处理。
 */
export function graphStep(nodes: readonly GraphNode[]): GraphChange[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  const changes: GraphChange[] = [];
  for (const node of topoOrder(nodes, (n) => n.id, (n) => n.dependsOn).order) {
    if (node.status !== 'waiting_dependency' && !blockedByUpstream(node)) continue;
    const deps = node.dependsOn.filter((d) => byId.has(d));
    const trouble = deps.find((d) => UPSTREAM_TROUBLE[status.get(d)!] !== undefined);
    const to: SubtaskStatus = trouble ? 'blocked' : deps.every((d) => status.get(d) === 'succeeded') ? 'queued' : 'waiting_dependency';
    status.set(node.id, to);
    if (to === node.status) continue;
    const from = node.status;
    changes.push(trouble ? { id: node.id, from, to, reason: upstreamBlockReason(byId.get(trouble)!.title, status.get(trouble)!) } : { id: node.id, from, to });
  }
  return changes;
}

const FINISHED = new Set<SubtaskStatus>(['succeeded', 'failed', 'cancelled']);
const ACTIVE = new Set<SubtaskStatus>(['running', 'waiting_approval', 'review']);
const WAITING = new Set<SubtaskStatus>(['queued', 'waiting_dependency']);

/**
 * 任务状态由子任务推导，单子任务和任务图共用（与 P1 的行为一致）：
 * 全部成功 → 成功；全部结束且有取消 → 取消，否则失败；有执行中 / 等审批 / 待验收 → 执行中；
 * 有排队 / 等依赖 → 已在执行中就保持，否则排队；其余（都卡住了）→ 阻塞。没有子任务时不变（草稿）。
 */
export function taskStatusOf(current: TaskStatus, subtasks: readonly SubtaskStatus[]): TaskStatus {
  if (subtasks.length === 0) return current;
  if (subtasks.every((s) => s === 'succeeded')) return 'succeeded';
  if (subtasks.every((s) => FINISHED.has(s))) return subtasks.includes('cancelled') ? 'cancelled' : 'failed';
  if (subtasks.some((s) => ACTIVE.has(s))) return 'running';
  if (subtasks.some((s) => WAITING.has(s))) return current === 'running' ? 'running' : 'queued';
  return 'blocked';
}

/**
 * 任务从 from 到 to 要经过的状态（按状态机的最短路径，例如 blocked → queued → running）；到不了返回 undefined。
 * 正常流程里都是一步，多步只出现在几件事挤在同一次推进里的时候。
 */
export function taskPath(from: TaskStatus, to: TaskStatus): TaskStatus[] | undefined {
  const paths = new Map<TaskStatus, TaskStatus[]>([[from, []]]);
  for (const [state, path] of paths) {
    if (state === to) return path;
    for (const next of TASK_STATUSES) if (!paths.has(next) && taskMachine.canTransition(state, next)) paths.set(next, [...path, next]);
  }
  return undefined;
}

/** 两版计划里同一节点键的节点有没有实质变化（标题不算：只是名字）。 */
function sameNode(a: PlanNodeInput & { executor?: string | null; checkCommand?: unknown }, b: typeof a): boolean {
  const pick = (n: typeof a) => JSON.stringify([n.role, n.goal, [...n.paths].sort(), [...n.dependsOn].sort(), n.checkCommand ?? n.check ?? null, n.executor ?? null]);
  return pick(a) === pick(b);
}

export interface PlanDiff {
  /** 沿用原子任务和结论。 */
  keep: string[];
  /** 改了（或上游被重新执行）：原子任务作废，按新节点重新执行。 */
  replace: string[];
  /** 新版本里新增的。 */
  add: string[];
  /** 新版本里没有了：原子任务作废。 */
  drop: string[];
}

/**
 * 运行中改计划：按节点键对照两版。角色、目标、路径、依赖、检查命令、执行器都没变的沿用；
 * 改了的重新执行，并且它下游（直接或间接依赖它）的节点也要重新执行，不能沿用基于旧上游的结论。
 */
export function planDiff<N extends PlanNodeInput & { executor?: string | null; checkCommand?: unknown }>(previous: readonly N[], next: readonly N[]): PlanDiff {
  const old = new Map(previous.map((n) => [n.key, n]));
  const redo = new Set<string>();
  const add: string[] = [];
  for (const node of next) {
    const before = old.get(node.key);
    if (!before) add.push(node.key);
    else if (!sameNode(before, node)) redo.add(node.key);
  }
  // 上游重新执行或新增的，下游跟着重新执行；按拓扑顺序一遍传完
  for (const node of topoOrder(next, (n) => n.key, (n) => n.dependsOn).order) {
    if (old.has(node.key) && node.dependsOn.some((d) => redo.has(d) || add.includes(d))) redo.add(node.key);
  }
  const keys = new Set(next.map((n) => n.key));
  return {
    keep: next.filter((n) => old.has(n.key) && !redo.has(n.key)).map((n) => n.key),
    replace: next.filter((n) => redo.has(n.key)).map((n) => n.key),
    add,
    drop: previous.filter((n) => !keys.has(n.key)).map((n) => n.key),
  };
}
