import type { ApprovalStrictness, CommandArgsOf, Executor, Isolation, ProjectAssistantsView, RemoteApprovalLevel, RoleIsolation, WorkspaceRecord } from '@paldock/contracts';
import { bridge, call } from '../api.js';
import { h } from '../dom.js';
import { navigate, projectLink } from '../router.js';
import { pausedBanner } from './paused.js';

type Act = (run: () => Promise<unknown>) => () => Promise<void>;
type ModePatch = Omit<CommandArgsOf<'project.setMode'>, 'workspaceId' | 'expectedVersion' | 'confirmDirect'>;
type RolePatch = Omit<CommandArgsOf<'project.setRole'>, 'workspaceId' | 'role' | 'expectedVersion' | 'confirmDirect'>;

const EXECUTOR_LABEL: Record<Executor, string> = { codex: 'Codex', claude: 'Claude Code' };
const ISOLATION_OPTION: Record<RoleIsolation, string> = { worktree: '独立 worktree', direct: '直接在项目目录里改', readonly: '只读' };
const APPROVAL_OPTION: Record<ApprovalStrictness, string> = { worktree_auto: '工作目录内自动批准', all: '每条都审批', high_only: '只审批高风险' };
const CHECK_LABEL: Record<Isolation, string> = { read_only: '只读', isolated: '隔离', not_isolated: '不隔离', unverified: '未验证' };
const LEVEL_LABEL: Record<RemoteApprovalLevel, string> = {
  L0: 'L0：只在桌面审批',
  L1: 'L1：外部渠道可审批低、中风险',
  L2: 'L2：外部渠道可审批全部（含高风险）',
};
const DIRECT_WARNING = '「直接在项目目录里改」会改你当前的分支和工作区（不建 worktree、不走集成分支合并），同一时刻只允许一个写入者。确定开启吗？';

function select<T extends string>(label: string, options: Record<T, string>, current: T, onPick: (value: T) => void): HTMLSelectElement {
  const el = h('select', { 'aria-label': label }, ...(Object.keys(options) as T[]).map((value) => h('option', { value, selected: value === current }, options[value]))) as HTMLSelectElement;
  el.addEventListener('change', () => onPick(el.value as T));
  return el;
}

/**
 * 「项目 → 助手」（2026-11-26 已定）：全局设置只当默认值，这里按项目覆盖工作模式（团队 / 单人）、启用的角色、
 * 每个角色的执行器、隔离方式、审批严格度和是否跳过审阅；简单计划自动确认、准备命令、远程审批等级也在这里。
 */
export async function projectView(workspaceId: string | undefined, rerender: () => void): Promise<HTMLElement> {
  const workspaces = await call('workspace.list', {});
  const error = h('p', { class: 'error', role: 'alert' });
  if (workspaces.length === 0) {
    const pick = async () => {
      const path = await bridge().pickProject();
      if (!path) return;
      try {
        await call('workspace.add', { rootPath: path });
        rerender();
      } catch (e) {
        error.textContent = (e as Error).message;
      }
    };
    return h('section', {}, h('h2', {}, '项目'), h('p', { class: 'empty' }, '还没有项目。'), error, h('button', { type: 'button', class: 'primary', onclick: () => void pick() }, '选择项目目录…'));
  }
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]!;
  const view = await call('project.assistants', { workspaceId: workspace.id });
  const act: Act = (run) => async () => {
    error.textContent = '';
    try {
      await run();
      rerender();
    } catch (e) {
      error.textContent = (e as Error).message;
      rerender();
    }
  };
  const picker = select('项目', Object.fromEntries(workspaces.map((w) => [w.id, w.name])) as Record<string, string>, workspace.id, (id) => navigate(projectLink(id)));
  return h(
    'section',
    { 'aria-labelledby': 'project-title' },
    h('h2', { id: 'project-title' }, '项目'),
    h('div', { class: 'row' }, picker, h('span', { class: 'hint' }, workspace.rootPath)),
    error,
    pausedBanner(view.workspace, act),
    workspaceModeSection(view.workspace, act),
    modeSection(view, act),
    view.settings.mode === 'team' ? rolesSection(view, act) : null,
    autoSection(view, act),
    prepareSection(view.workspace, act),
    remoteSection(view.workspace, act),
  );
}

function modeSection(view: ProjectAssistantsView, act: Act): HTMLElement {
  const { settings, workspace } = view;
  const setMode = (patch: ModePatch, direct = false) =>
    act(() => call('project.setMode', { workspaceId: workspace.id, expectedVersion: settings.version, ...patch, ...(direct ? { confirmDirect: true } : {}) }))();
  const modeSelect = select('工作模式', { team: '团队：协调助手提计划，专业助手分工', solo: '单人：一个助手全权接管' }, settings.mode, (mode) => {
    // 切到单人模式时，默认直接在项目目录里改：先确认
    if (mode === 'solo' && settings.soloIsolation === 'direct' && !window.confirm(DIRECT_WARNING)) return rerenderSelect(modeSelect, settings.mode);
    void setMode({ mode }, mode === 'solo' && settings.soloIsolation === 'direct');
  });
  const solo =
    settings.mode === 'solo'
      ? h(
          'div',
          { class: 'facts' },
          h('p', { class: 'hint' }, '你在「对话」里直接和它说话：它读代码、改代码、跑测试，不拆计划。'),
          h(
            'label',
            {},
            '执行器 ',
            select('单人助手的执行器', { '': `跟随协调助手（${EXECUTOR_LABEL[view.soloExecutor]}）`, codex: 'Codex', claude: 'Claude Code' }, settings.soloExecutor ?? '', (value) =>
              void setMode({ soloExecutor: (value || null) as Executor | null }),
            ),
          ),
          h(
            'label',
            {},
            ' 隔离方式 ',
            (() => {
              const el = select('单人助手的隔离方式', ISOLATION_OPTION, settings.soloIsolation, (soloIsolation) => {
                if (soloIsolation === 'direct' && !window.confirm(DIRECT_WARNING)) return rerenderSelect(el, settings.soloIsolation);
                void setMode({ soloIsolation }, soloIsolation === 'direct');
              });
              return el;
            })(),
          ),
          h('label', {}, ' 审批 ', select('单人助手的审批严格度', APPROVAL_OPTION, settings.soloApproval, (soloApproval) => void setMode({ soloApproval }))),
          h(
            'label',
            { class: 'inline' },
            (() => {
              const box = h('input', { type: 'checkbox', checked: settings.soloReview, 'aria-label': '改完让审阅助手看一遍' }) as HTMLInputElement;
              box.addEventListener('change', () => void setMode({ soloReview: box.checked }));
              return box;
            })(),
            ' 改完让审阅助手看一遍（结论作为一条消息出现在对话里）',
          ),
        )
      : null;
  return h('div', {}, h('h3', {}, '工作模式'), modeSelect, solo);
}

/** 用户在确认框里取消：把下拉框恢复成原来的值。 */
function rerenderSelect(el: HTMLSelectElement, value: string): void {
  el.value = value;
}

function rolesSection(view: ProjectAssistantsView, act: Act): HTMLElement {
  const { workspace } = view;
  return h(
    'div',
    {},
    h('h3', {}, '角色'),
    h('p', { class: 'hint' }, '协调助手只能派单给这里启用的角色。执行器、隔离方式、审批严格度只影响这个项目；没改过的跟随「设置 → 助手」。'),
    h(
      'table',
      { class: 'agents' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, '启用'), h('th', {}, '角色'), h('th', {}, '执行器'), h('th', {}, '隔离方式'), h('th', {}, '审批'), h('th', {}, '跳过审阅'), h('th', {}, '检查')),
      ),
      h(
        'tbody',
        {},
        ...view.roles.map(({ profile, setting, executor, override, skipReview, check }) => {
          const setRole = (patch: RolePatch, direct = false) =>
            act(() => call('project.setRole', { workspaceId: workspace.id, role: profile.role, expectedVersion: setting.version, ...patch, ...(direct ? { confirmDirect: true } : {}) }))();
          const enabled = h('input', { type: 'checkbox', checked: setting.enabled, 'aria-label': `启用${profile.displayName}` }) as HTMLInputElement;
          enabled.addEventListener('change', () => void setRole({ enabled: enabled.checked }));
          const isolation = select(`${profile.displayName}的隔离方式`, ISOLATION_OPTION, setting.isolation, (value) => {
            if (value === 'direct' && !window.confirm(DIRECT_WARNING)) return rerenderSelect(isolation, setting.isolation);
            void setRole({ isolation: value }, value === 'direct');
          });
          const skip = h('input', { type: 'checkbox', checked: skipReview, disabled: profile.role === 'reviewer', 'aria-label': `${profile.displayName}跳过审阅` }) as HTMLInputElement;
          skip.addEventListener('change', () => {
            const roles = workspace.autoPolicy.skipReviewRoles;
            const next = skip.checked ? [...roles, profile.role] : roles.filter((r) => r !== profile.role);
            void act(() => call('workspace.setAutoPolicy', { workspaceId: workspace.id, expectedVersion: workspace.version, policy: { skipReviewRoles: next } }))();
          });
          const label = setting.isolation === 'direct' ? '不隔离（直接改项目目录）' : CHECK_LABEL[check.isolation];
          return h(
            'tr',
            { class: setting.enabled ? '' : 'disabled' },
            h('td', {}, enabled),
            h('td', { title: profile.description }, profile.displayName),
            h(
              'td',
              {},
              select(`${profile.displayName}的执行器`, { '': `跟随默认（${EXECUTOR_LABEL[profile.executor]}）`, codex: 'Codex', claude: 'Claude Code' }, override ?? '', (value) =>
                void act(() => call('agent.setOverride', { workspaceId: workspace.id, role: profile.role, executor: (value || null) as Executor | null }))(),
              ),
              h('div', { class: 'hint' }, `实际：${EXECUTOR_LABEL[executor]}`),
            ),
            h('td', {}, isolation),
            h('td', {}, select(`${profile.displayName}的审批严格度`, APPROVAL_OPTION, setting.approval, (approval) => void setRole({ approval }))),
            h('td', {}, skip),
            h('td', { class: `isolation ${check.isolation}` }, label, h('div', { class: 'hint' }, check.ok ? check.warnings.join('；') : `不能启动：${check.problems.join('；')}`)),
          );
        }),
      ),
    ),
  );
}

function autoSection({ workspace }: ProjectAssistantsView, act: Act): HTMLElement {
  const box = h('input', { type: 'checkbox', checked: workspace.autoPolicy.autoConfirmSimplePlans, 'aria-label': '简单计划自动确认' }) as HTMLInputElement;
  box.addEventListener('change', () => {
    void act(() =>
      call('workspace.setAutoPolicy', {
        workspaceId: workspace.id,
        expectedVersion: workspace.version,
        policy: { skipReviewRoles: workspace.autoPolicy.skipReviewRoles, autoConfirmSimplePlans: box.checked },
      }),
    )();
  });
  return h(
    'div',
    {},
    h('h3', {}, '自动处理'),
    h('label', { class: 'inline' }, box, ' 简单计划自动确认'),
    h('p', { class: 'hint' }, '只有 1 个节点、不带检查命令的新计划，提出 30 秒后自动确认，这段时间里可以在对话里撤回；每次都记进「自动处理记录」。'),
  );
}

function prepareSection(workspace: WorkspaceRecord, act: Act): HTMLElement {
  const exe = h('input', { type: 'text', value: workspace.prepareCommand?.executable ?? '', placeholder: 'pnpm', 'aria-label': '准备命令' }) as HTMLInputElement;
  const args = h('textarea', { rows: 2, placeholder: '每行一个参数', 'aria-label': '准备命令参数' }, (workspace.prepareCommand?.args ?? []).join('\n')) as HTMLTextAreaElement;
  const save = () => {
    const executable = exe.value.trim();
    const command = executable ? { executable, args: args.value.split(/\r?\n/).filter((line) => line !== '') } : null;
    return act(() => call('workspace.setPrepareCommand', { workspaceId: workspace.id, expectedVersion: workspace.version, command }))();
  };
  return h(
    'div',
    {},
    h('h3', {}, 'worktree 准备命令'),
    h('p', { class: 'hint' }, '新建的 worktree 跑检查命令前先执行一次（例如 pnpm，参数 install）。以你的账户权限运行，可以联网。留空表示不需要。'),
    exe,
    args,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => void save() }, '保存')),
  );
}

function remoteSection(workspace: WorkspaceRecord, act: Act): HTMLElement {
  const level = select('远程审批等级', LEVEL_LABEL, workspace.remoteApprovalLevel, (value) => {
    if (value === 'L2' && !window.confirm(`确定让外部渠道也能批准「${workspace.name}」的高风险操作吗？`)) return rerenderSelect(level, workspace.remoteApprovalLevel);
    void act(() => call('workspace.setRemoteApprovalLevel', { workspaceId: workspace.id, expectedVersion: workspace.version, level: value }))();
  });
  return h(
    'div',
    {},
    h('h3', {}, '远程审批'),
    h('p', { class: 'hint' }, '审批先在桌面等待；桌面 3 分钟无人处理、或锁屏、空闲时才发到已绑定的单聊。权限类审批始终只能在桌面处理。'),
    level,
  );
}

/**
 * 工作区方式（2026-11-26 已定）：当前工作区（新项目默认）——所有助手直接改这个目录，你在 IDE 里马上看到改动，
 * 提交、推送由你在对话里指挥；独立 worktree——每个子任务一个 worktree，做完合进任务集成分支，显示「待合并」。
 */
function workspaceModeSection(workspace: WorkspaceRecord, act: Act): HTMLElement {
  const el = select('工作区方式', { current: '当前工作区：助手直接改这个目录，提交和推送由你指挥', worktree: '独立 worktree：每个子任务一个 worktree，做完合进集成分支' }, workspace.workspaceMode, (mode) => {
    if (mode === 'current' && !window.confirm('改成当前工作区：助手会直接改这个目录（你当前的分支和工作区），同一项目同一时刻只跑一个助手。确定吗？')) {
      return rerenderSelect(el, workspace.workspaceMode);
    }
    void act(() => call('workspace.setMode', { workspaceId: workspace.id, expectedVersion: workspace.version, mode }))();
  });
  return h('div', {}, h('h3', {}, '工作区'), el);
}
