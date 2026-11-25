import type {
  AgentOverrideRecord,
  AgentSettings,
  Executor,
  Isolation,
  ChannelAccountRecord,
  ChannelOverview,
  ChannelProvider,
  ChannelState,
  ConversationRecord,
  PairingRecord,
  RemoteApprovalLevel,
  WorkspaceRecord,
} from '@paldock/contracts';
import { call } from '../api.js';
import { field, h } from '../dom.js';
import { time } from '../format.js';

const PROVIDER_LABEL: Record<ChannelProvider, string> = { feishu: '飞书', telegram: 'Telegram' };

const STATE_LABEL: Record<ChannelState, string> = {
  stopped: '未启用',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  error: '出错',
};

const LEVEL_LABEL: Record<RemoteApprovalLevel, string> = {
  L0: 'L0：只在桌面审批',
  L1: 'L1：外部渠道可审批低、中风险',
  L2: 'L2：外部渠道可审批全部（含高风险）',
};

/**
 * 设置页：外部渠道（凭据、代理、启停、状态）、待确认的配对、已绑定账号、群聊白名单、各项目的远程审批等级。
 * 凭据只写不读：输入框留空表示不修改，保存后立即清空。
 */
export async function settingsView(rerender: () => void): Promise<HTMLElement> {
  const [overview, pairings, accounts, groups, workspaces, agents] = await Promise.all([
    call('channel.overview', {}),
    call('channel.pairings', {}),
    call('channel.accounts', {}),
    call('channel.groups', {}),
    call('workspace.list', {}),
    call('agent.settings', {}),
  ]);
  const overrides = await Promise.all(workspaces.map((w) => call('agent.overrides', { workspaceId: w.id })));
  const error = h('p', { class: 'error', role: 'alert' });
  /** 执行一个修改，失败时显示原因；成功后重绘（拒绝配对等操作不产生事件）。 */
  const act = (run: () => Promise<unknown>) => async () => {
    error.textContent = '';
    try {
      await run();
      rerender();
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  };

  return h(
    'section',
    { 'aria-labelledby': 'settings-title' },
    h('h2', { id: 'settings-title' }, '设置'),
    error,
    agentSection(agents, workspaces, overrides, act),
    h('h3', {}, '外部渠道'),
    h('p', { class: 'hint' }, '凭据保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），不会显示或写入日志。'),
    ...overview.map((item) => channelForm(item, act)),
    pairingSection(pairings, act),
    accountSection(accounts, act),
    groupSection(groups, act),
    workspaceSection(workspaces, act),
    prepareSection(workspaces, act),
  );
}

type Act = (run: () => Promise<unknown>) => () => Promise<void>;

const EXECUTOR_LABEL: Record<Executor, string> = { codex: 'Codex', claude: 'Claude Code' };
const ISOLATION_LABEL: Record<Isolation, string> = { read_only: '只读', isolated: '隔离', not_isolated: '不隔离', unverified: '未验证' };
const SOURCE_LABEL: Record<string, string> = {
  configured: '设置里的路径',
  path: 'PATH',
  'npm-shim': 'npm 全局安装',
  standalone: '独立安装',
  'desktop-bundled': 'Claude 桌面版自带',
};

const executorSelect = (label: string, current: Executor | '', withDefault: boolean, onPick: (value: Executor | null) => void) => {
  const select = h(
    'select',
    { 'aria-label': label },
    ...(withDefault ? [h('option', { value: '', selected: current === '' }, '跟随默认')] : []),
    ...(['claude', 'codex'] as const).map((e) => h('option', { value: e, selected: e === current }, EXECUTOR_LABEL[e])),
  );
  select.addEventListener('change', () => onPick((select.value || null) as Executor | null));
  return select;
};

/**
 * 助手：每个角色的默认执行器、能力检查（隔离程度、不能启动的原因），各执行器是否可用，以及按项目覆盖执行器。
 * 「不隔离」是 Windows 实测的结论：可写角色获批的命令能写到 worktree 以外，交付范围只在验收时核对。
 */
function agentSection({ agents, runtimes }: AgentSettings, workspaces: WorkspaceRecord[], overrides: AgentOverrideRecord[][], act: Act): HTMLElement {
  return h(
    'div',
    {},
    h('h3', {}, '助手'),
    h(
      'dl',
      { class: 'facts' },
      ...runtimes.flatMap((d) => [
        h('dt', {}, EXECUTOR_LABEL[d.runtime as Executor] ?? d.runtime),
        h(
          'dd',
          { title: d.executable?.path ?? '' },
          d.available
            ? `可用 ${d.version ?? ''}${d.executable ? `（${SOURCE_LABEL[d.executable.source] ?? d.executable.source}）` : ''}`
            : `不可用：${d.reason ?? '原因未知'}`,
        ),
      ]),
    ),
    h(
      'table',
      { class: 'agents' },
      h('thead', {}, h('tr', {}, h('th', {}, '角色'), h('th', {}, '执行器'), h('th', {}, '隔离'), h('th', {}, '检查'))),
      h(
        'tbody',
        {},
        ...agents.map(({ profile, check }) =>
          h(
            'tr',
            {},
            h('td', { title: profile.description }, profile.displayName),
            h(
              'td',
              {},
              executorSelect(`${profile.displayName}的执行器`, profile.executor, false, (executor) =>
                void act(() => call('agent.setExecutor', { role: profile.role, expectedVersion: profile.version, executor: executor! }))(),
              ),
            ),
            h('td', { class: `isolation ${check.isolation}` }, ISOLATION_LABEL[check.isolation]),
            h('td', {}, check.ok ? [...check.warnings].join('；') || '通过' : `不能启动：${check.problems.join('；')}`),
          ),
        ),
      ),
    ),
    ...workspaces.map((w, i) => {
      const byRole = new Map((overrides[i] ?? []).map((o) => [o.role, o.executor]));
      return h(
        'details',
        {},
        h('summary', {}, `「${w.name}」的执行器覆盖（${byRole.size} 项）`),
        h(
          'dl',
          { class: 'facts' },
          ...agents.flatMap(({ profile }) => [
            h('dt', {}, profile.displayName),
            h(
              'dd',
              {},
              executorSelect(`${w.name} 里${profile.displayName}的执行器`, byRole.get(profile.role) ?? '', true, (executor) =>
                void act(() => call('agent.setOverride', { workspaceId: w.id, role: profile.role, executor }))(),
              ),
            ),
          ]),
        ),
      );
    }),
  );
}

function channelForm({ settings, status, appId, recentlyRecovered }: ChannelOverview, act: Act): HTMLElement {
  const { provider } = settings;
  const id = (name: string) => `${provider}-${name}`;
  const feishu = provider === 'feishu';
  const form: HTMLFormElement = h(
    'form',
    { class: 'panel channel', 'aria-labelledby': id('title') },
    h(
      'div',
      { class: 'section-head' },
      h('h4', { id: id('title') }, PROVIDER_LABEL[provider]),
      h('span', { class: `status channel-${status.state}` }, STATE_LABEL[status.state], status.state !== 'stopped' ? `（${time(status.since)} 起）` : ''),
    ),
    status.detail ? h('p', { class: status.state === 'error' ? 'error' : 'hint' }, status.detail) : null,
    recentlyRecovered ? h('p', { class: 'warning' }, '渠道刚恢复，外部消息可能延迟到达。') : null,
    h('label', {}, h('input', { type: 'checkbox', id: id('enabled'), 'data-keep': id('enabled'), checked: settings.enabled }), ' 启用'),
    ...(feishu
      ? [
          h('label', { for: id('app-id') }, 'App ID'),
          h('input', { id: id('app-id'), 'data-keep': id('app-id'), autocomplete: 'off', placeholder: 'cli_…', value: appId ?? '' }),
        ]
      : []),
    h('label', { for: id('secret') }, feishu ? 'App Secret' : 'Bot Token'),
    h('input', {
      id: id('secret'),
      type: 'password',
      'data-keep': id('secret'),
      autocomplete: 'off',
      placeholder: '留空表示不修改已保存的凭据',
    }),
    ...(feishu
      ? [h('p', { class: 'hint' }, '修改凭据时 App ID 与 App Secret 需要一起填写。')]
      : [
          h('label', { for: id('proxy') }, '代理（可选）'),
          h('input', { id: id('proxy'), 'data-keep': id('proxy'), placeholder: 'http://127.0.0.1:7890', value: settings.proxyUrl ?? '' }),
          h('p', { class: 'hint' }, '只支持 HTTP 代理。申请 bot 的步骤见 docs/ops/telegram-bot.md。'),
        ]),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'submit', class: 'primary' }, '保存'),
      h('button', { type: 'button', class: 'danger', onclick: act(() => save(true)) }, '删除凭据'),
    ),
  );

  function save(forgetCredential: boolean): Promise<void> {
    const secret = field<HTMLInputElement>(form, `#${id('secret')}`).value.trim();
    const newAppId = feishu ? field<HTMLInputElement>(form, `#${id('app-id')}`).value.trim() : '';
    // 只在填了 Secret / Token 时更新凭据；飞书只改 App ID 不填 Secret 时不更新
    const credential = secret && !forgetCredential ? { secret, ...(newAppId ? { appId: newAppId } : {}) } : {};
    return call('channel.configure', {
      provider,
      expectedVersion: settings.version,
      enabled: field<HTMLInputElement>(form, `#${id('enabled')}`).checked,
      proxyUrl: feishu ? (settings.proxyUrl ?? '') : field<HTMLInputElement>(form, `#${id('proxy')}`).value,
      forgetCredential,
      ...credential,
    }).then(() => {
      field<HTMLInputElement>(form, `#${id('secret')}`).value = '';
    });
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void act(() => save(false))();
  });
  return form;
}

function pairingSection(pairings: PairingRecord[], act: Act): HTMLElement {
  return h(
    'div',
    {},
    h('h3', {}, '待确认的配对'),
    h('p', { class: 'hint' }, '在外部渠道私聊机器人会收到配对码；核对配对码与对方一致后再确认。确认后该账号可以给 PalDock 发任务。'),
    pairings.length === 0
      ? h('p', { class: 'empty' }, '没有待确认的配对。')
      : h(
          'ul',
          { class: 'plain-list' },
          ...pairings.map((p) =>
            h(
              'li',
              { class: 'panel' },
              h('strong', { class: 'code' }, `${p.code.slice(0, 4)}-${p.code.slice(4)}`),
              ` ${PROVIDER_LABEL[p.provider]} · ${p.displayName} · ${time(p.expiresAt)} 前有效`,
              h(
                'div',
                { class: 'actions' },
                h('button', { type: 'button', class: 'primary', onclick: act(() => call('channel.decidePairing', { code: p.code, approve: true })) }, '确认绑定'),
                h('button', { type: 'button', onclick: act(() => call('channel.decidePairing', { code: p.code, approve: false })) }, '拒绝'),
              ),
            ),
          ),
        ),
  );
}

const ACCOUNT_LABEL = { unbound: '未绑定', active: '已绑定', revoked: '已解绑' } as const;

function accountSection(accounts: ChannelAccountRecord[], act: Act): HTMLElement {
  const known = accounts.filter((a) => a.status !== 'unbound');
  return h(
    'div',
    {},
    h('h3', {}, '已绑定的账号'),
    known.length === 0
      ? h('p', { class: 'empty' }, '还没有绑定账号。')
      : h(
          'table',
          { class: 'tasks' },
          h('thead', {}, h('tr', {}, h('th', {}, '渠道'), h('th', {}, '名字'), h('th', {}, '状态'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            ...known.map((a) =>
              h(
                'tr',
                {},
                h('td', {}, PROVIDER_LABEL[a.provider]),
                h('td', {}, a.displayName),
                h('td', { class: `status account-${a.status}` }, ACCOUNT_LABEL[a.status]),
                h(
                  'td',
                  {},
                  a.status === 'active'
                    ? h('button', { type: 'button', class: 'danger', onclick: act(() => call('channel.setAccountStatus', { accountId: a.id, expectedVersion: a.version, status: 'revoked' })) }, '解绑')
                    : h('button', { type: 'button', onclick: act(() => call('channel.setAccountStatus', { accountId: a.id, expectedVersion: a.version, status: 'unbound' })) }, '允许重新配对'),
                ),
              ),
            ),
          ),
        ),
    h('p', { class: 'hint' }, '解绑后该账号的消息一律拒绝，已发出的按钮也失效。'),
  );
}

function groupSection(groups: ConversationRecord[], act: Act): HTMLElement {
  return h(
    'div',
    {},
    h('h3', {}, '群聊白名单'),
    h('p', { class: 'hint' }, '机器人被拉进群后，群在这里出现；只有勾选的群里、@机器人的消息才会处理，且发起人必须是已绑定账号。'),
    groups.length === 0
      ? h('p', { class: 'empty' }, '机器人还没有收到过群消息。')
      : h(
          'ul',
          { class: 'plain-list' },
          ...groups.map((g) =>
            h(
              'li',
              {},
              h(
                'label',
                { class: 'inline' },
                h('input', {
                  type: 'checkbox',
                  checked: g.groupAllowed,
                  onchange: act(() => call('channel.setGroupAllowed', { conversationId: g.id, expectedVersion: g.version, allowed: !g.groupAllowed })),
                }),
                ` ${PROVIDER_LABEL[g.provider]} · ${g.title || g.chatId}`,
              ),
            ),
          ),
        ),
  );
}

/**
 * worktree 准备命令：新建的 worktree（计划节点、合并候选）跑检查命令前先执行一次，例如安装依赖。
 * 和检查命令一样是「可执行文件 + 每行一个参数」，不经 shell，以你的账户权限运行。
 */
function prepareSection(workspaces: WorkspaceRecord[], act: Act): HTMLElement {
  return h(
    'div',
    {},
    h('h3', {}, 'worktree 准备命令'),
    h(
      'p',
      { class: 'hint' },
      '新建的 worktree 没有安装依赖。这里的命令会在跑检查命令前先执行一次（例如 pnpm，参数 install、--frozen-lockfile），失败时按检查失败处理。命令以你的账户权限运行，可以联网。留空表示不需要。',
    ),
    workspaces.length === 0
      ? h('p', { class: 'empty' }, '还没有项目。')
      : h(
          'div',
          {},
          ...workspaces.map((w) => {
            const exe = h('input', { type: 'text', value: w.prepareCommand?.executable ?? '', placeholder: 'pnpm', 'aria-label': `${w.name} 的准备命令` }) as HTMLInputElement;
            const args = h('textarea', { rows: 2, placeholder: '每行一个参数', 'aria-label': `${w.name} 的准备命令参数` }, (w.prepareCommand?.args ?? []).join('\n')) as HTMLTextAreaElement;
            const save = () => {
              const executable = exe.value.trim();
              const command = executable ? { executable, args: args.value.split(/\r?\n/).filter((line) => line !== '') } : null;
              return act(() => call('workspace.setPrepareCommand', { workspaceId: w.id, expectedVersion: w.version, command }))();
            };
            return h(
              'fieldset',
              {},
              h('legend', { title: w.rootPath }, w.name),
              exe,
              args,
              h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => void save() }, '保存')),
            );
          }),
        ),
  );
}

function workspaceSection(workspaces: WorkspaceRecord[], act: Act): HTMLElement {
  return h(
    'div',
    {},
    h('h3', {}, '远程审批'),
    h(
      'p',
      { class: 'hint' },
      '审批先在桌面等待；桌面 3 分钟无人处理、或锁屏、空闲时才发到已绑定的单聊。等级决定外部渠道能批准哪些操作；权限类审批始终只能在桌面处理。',
    ),
    workspaces.length === 0
      ? h('p', { class: 'empty' }, '还没有项目。')
      : h(
          'div',
          { class: 'facts' },
          ...workspaces.flatMap((w) => {
            const select = h(
              'select',
              { 'aria-label': `${w.name} 的远程审批等级` },
              ...(['L0', 'L1', 'L2'] as const).map((level) => h('option', { value: level, selected: level === w.remoteApprovalLevel }, LEVEL_LABEL[level])),
            );
            select.addEventListener('change', () => {
              const level = select.value as RemoteApprovalLevel;
              if (level === 'L2' && !window.confirm(`确定让外部渠道也能批准「${w.name}」的高风险操作吗？`)) {
                select.value = w.remoteApprovalLevel;
                return;
              }
              void act(() => call('workspace.setRemoteApprovalLevel', { workspaceId: w.id, expectedVersion: w.version, level }))();
            });
            return [h('dt', { title: w.rootPath }, w.name), h('dd', {}, select)];
          }),
        ),
  );
}
