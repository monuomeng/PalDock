import type { CheckStatus, ReviewDecision } from '@paldock/contracts';

/**
 * 计划节点的验收闸门：交付范围核对、检查结果与审阅结论的判定。都是纯函数，执行（git、检查命令、审阅 Run）在应用层。
 */

const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** glob 转正则：`**` 跨目录、`*` 和 `?` 不跨 `/`；不带通配符的路径当作文件或目录前缀。 */
function matcher(pattern: string): (file: string) => boolean {
  const p = normalize(pattern);
  if (!/[*?]/.test(p)) return (file) => file === p || file.startsWith(`${p}/`);
  let source = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*' && p[i + 1] === '*') {
      // `**/` 匹配零到多级目录，单独的 `**` 匹配任意内容
      if (p[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`);
  return (file) => re.test(file);
}

/**
 * 越出交付范围的文件。范围 = 角色的交付范围 ∪ 节点的相关路径；两者都为空表示整个 worktree，不核对。
 * 文件路径是相对 worktree 的 git 路径（`/` 分隔）。
 */
export function outOfScope(files: readonly string[], scope: readonly string[]): string[] {
  if (scope.length === 0) return [];
  const matchers = scope.map(matcher);
  return files.map(normalize).filter((file) => !matchers.some((m) => m(file)));
}

const CHECK_TEXT: Partial<Record<CheckStatus, string>> = { failed: '没通过', timed_out: '超时', error: '没能运行', cancelled: '被中止' };

export type WorkGateOutcome = { outcome: 'human'; reason: string } | { outcome: 'review' } | { outcome: 'passed' };

/**
 * 工作 Run 交付后的第一道关：越界或检查没通过就交给人；否则可写角色交给审阅助手，只读角色（没有改动可审）直接通过。
 * 未配置检查命令不算失败。
 */
export function gateAfterWork(input: { outOfScope: readonly string[]; checkStatus: CheckStatus; writable: boolean }): WorkGateOutcome {
  const problems: string[] = [];
  if (input.outOfScope.length > 0) {
    const shown = input.outOfScope.slice(0, 5).join('、');
    problems.push(`越出交付范围：${shown}${input.outOfScope.length > 5 ? ` 等 ${input.outOfScope.length} 个文件` : ''}`);
  }
  const check = CHECK_TEXT[input.checkStatus];
  if (check) problems.push(`检查命令${check}`);
  if (problems.length > 0) return { outcome: 'human', reason: problems.join('；') };
  return input.writable ? { outcome: 'review' } : { outcome: 'passed' };
}

export type ReviewGateOutcome = { outcome: 'passed' } | { outcome: 'rework'; reason: string } | { outcome: 'human'; reason: string };

/**
 * 审阅 Run 结束后：通过放行；退回且自动轮数没用完就回到开发助手的会话重做；
 * 审阅失败、没交结论、或自动退回已满 maxAutoReworks 轮，交给人。previousReworks 是这次之前审阅助手已退回的次数。
 */
export function gateAfterReview(input: {
  verdict: { decision: ReviewDecision; note: string | null } | undefined;
  failure: string | undefined;
  previousReworks: number;
  maxAutoReworks: number;
}): ReviewGateOutcome {
  const { verdict, failure, previousReworks, maxAutoReworks } = input;
  if (failure) return { outcome: 'human', reason: `审阅没有完成：${failure}` };
  if (!verdict) return { outcome: 'human', reason: '审阅助手没有给出结论' };
  if (verdict.decision === 'accept') return { outcome: 'passed' };
  const note = verdict.note ?? '（没有写理由）';
  if (previousReworks >= maxAutoReworks) return { outcome: 'human', reason: `审阅助手已自动退回 ${previousReworks} 轮，这次仍退回：${note}` };
  return { outcome: 'rework', reason: note };
}
