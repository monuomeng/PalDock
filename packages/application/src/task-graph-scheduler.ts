import type { PersistentEvent, PlanNodeRecord, StorePort, SubtaskRecord } from '@paldock/contracts';
import { graphStep, taskMachine } from '@paldock/domain';
import { planNodePrompt, type UpstreamHandoff } from './prompts.js';
import type { RunPlan } from './run-supervisor.js';
import { settleTask } from './transitions.js';
import { MicroBatch } from './util.js';

export interface SchedulerDeps {
  store: StorePort;
  /** 只用到入队：并发（全局、每任务、同一会话串行）由监管器统一管。 */
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void };
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
}

/** 计划节点（按子任务所属的计划和节点键找）。 */
export function nodeOf(store: StorePort, subtask: SubtaskRecord): PlanNodeRecord | undefined {
  return subtask.planId && subtask.nodeKey ? store.plans.node(subtask.planId, subtask.nodeKey) : undefined;
}

/** 节点在界面和消息里的名字：节点标题，找不到节点时用目标开头。 */
export const nodeTitle = (store: StorePort, subtask: SubtaskRecord) => nodeOf(store, subtask)?.title ?? subtask.goal.slice(0, 40);

/** 一次 Run 的交接摘要（submit_result），没有时用最终回复。 */
export function handoffOf(store: StorePort, runId: string): string | null {
  return store.runs.getHandoff(runId)?.summary ?? store.runs.getResult(runId)?.finalMessage ?? null;
}

/** 上游子任务的交接：各自最新一次工作 Run 的交接摘要。 */
export function upstreamOf(store: StorePort, subtask: SubtaskRecord): UpstreamHandoff[] {
  if (!subtask.planId) return [];
  const graph = store.plans.graph(subtask.taskId);
  const self = graph.find((n) => n.id === subtask.id);
  return (self?.dependsOn ?? []).map((id) => {
    const latest = store.runs.latestRun(id);
    return { title: graph.find((n) => n.id === id)?.title ?? id, summary: latest ? handoffOf(store, latest.id) : null };
  });
}

/**
 * 任务图调度：事件驱动。服务广播的持久事件里有计划子任务的状态变化时，在下一个微任务里推进它所在的任务
 * （不在产生事件的那个事务里写库）：按 domain 的 graphStep 放行、阻塞或解除阻塞下游，重新推导任务状态，
 * 把新排队的交给监管器。所有迁移都带读到的版本，冲突说明别处先改了，整批放弃，等下一次事件再算。
 */
export class TaskGraphScheduler {
  private readonly batch: MicroBatch<string>;

  constructor(private readonly deps: SchedulerDeps) {
    this.batch = new MicroBatch((taskId) => void this.advance(taskId), deps.log, 'advance');
  }

  onEvents(events: readonly PersistentEvent[]): void {
    for (const event of events) {
      if (event.type !== 'subtask.status_changed') continue;
      const subtask = this.deps.store.tasks.getSubtask(event.aggregateId);
      if (subtask?.planId) this.batch.add(subtask.taskId);
    }
  }

  /** 推进一个任务图一步（graphStep 一次给出链式变化）；返回新排队的子任务。 */
  advance(taskId: string): string[] {
    const { store } = this.deps;
    const task = store.tasks.getTask(taskId);
    if (!task || task.status === 'draft' || taskMachine.isTerminal(task.status)) return [];
    const graph = store.plans.graph(taskId);
    const changes = graphStep(graph);
    if (changes.length === 0) return [];
    const versions = new Map(graph.map((n) => [n.id, n.version]));
    const events = store.transaction(() => {
      const out = changes.flatMap((c) => {
        const change = store.tasks.transitionSubtask(c.id, versions.get(c.id)!, c.to, c.reason);
        versions.set(c.id, change.record.version);
        return change.events;
      });
      return [...out, ...settleTask(store, taskId)];
    });
    this.deps.publish(events);
    const released = [...new Set(changes.filter((c) => c.to === 'queued').map((c) => c.id))];
    for (const id of released) this.dispatch(id);
    return released;
  }

  /** 把已排队的计划子任务交给监管器（首次 Run 的提示词带节点目标与上游交接）。 */
  dispatch(subtaskId: string): void {
    const { store } = this.deps;
    const subtask = store.tasks.getSubtask(subtaskId);
    if (subtask?.status !== 'queued') return;
    this.deps.supervisor.enqueue(subtaskId, { prompt: this.promptFor(subtask) });
  }

  promptFor(subtask: SubtaskRecord): string {
    const { store } = this.deps;
    const task = store.tasks.getTask(subtask.taskId)!;
    const node = nodeOf(store, subtask) ?? { title: nodeTitle(store, subtask), goal: subtask.goal, paths: [] };
    return planNodePrompt(task, node, upstreamOf(store, subtask));
  }
}
