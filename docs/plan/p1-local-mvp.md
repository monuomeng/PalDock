# P1 开发计划：本地最小产品

状态：**草案，待用户审阅**（2026-11-23）。负责人：Claude；分支 `claude/project-thread-8azrof`，基于已合入 master 的 P0（`d0d9cd0`）。设计依据见 [架构](../02-architecture.md)、[ADR 0002](../adr/0002-process-topology-and-task-board.md)、[路线图](../03-roadmap.md) 和 [P0 实测记录](../p0/findings.md)；完成后的前因后果写在 `docs/pr/p1-local-mvp.md`。

## 目标

做出一个可安装的开发预览：用户在管理窗口选一个本地 git 仓库，新建任务，PalDock 在独立 worktree 里启动 Codex 执行，界面流式回显输出、弹出审批、显示结果和改动，用户验收或退回重做。「待我处理」是首页。

退出条件（路线图 P1）：在临时测试仓库里从建任务到执行再到回显跑通；拒绝、取消、崩溃重启、重复启动都有测试；备份和卸载有说明。

## P1 的范围取舍

为了在 P1 先打通一条完整的链路，下面几处有意做简化，后续阶段再扩展：

1. **一个任务一个子任务**。用户建任务时直接写目标，服务自动建一个「开发助手」子任务。P1 没有协调助手和 `propose_plan`，也没有 MCP 桥（P3 做）。表结构仍保留 Task / Subtask / Run 三层，以后不用改表。
2. **执行器只有 Codex**，另加一个离线的模拟执行器（mock app-server）给测试和 CI 用。Claude 适配器在 P3。
3. **审批只在桌面**。没有外部渠道，也就没有升级；审批有过期时间（占位 30 分钟），过期即拒绝。
4. **验收由用户点按钮**。服务在 Run 结束后自动收集证据：git 改动统计、最终回复、用户可选填的检查命令（如 `pnpm test`）及其退出码和输出摘要。服务不自动合并分支，只显示分支名，合并由用户自己做。
5. **生命周期只做「随界面退出」**。托盘常驻和开机自启留到 P4。

## 工作项与顺序

每一项完成后跑一次 `pnpm build && pnpm test`，并提交一次；P1-02 到 P1-04 全部完成后统一跑 `/simplify` 和 `/code-review`。

| 顺序 | 积压 ID | 内容 | 完成标准 |
|---|---|---|---|
| 1 | P1-01 | 工程骨架补全与 CI | 见下文 |
| 2 | P1-02 | 会话、任务持久化与迁移 002；备份与恢复 | 见下文 |
| 3 | P1-03 | Codex 运行时适配器 + 模拟执行器；`packages/application` 用例层 | 见下文 |
| 4 | P1-04 | 管理窗口：「待我处理」、任务列表、任务详情、审批、断线提示 | 见下文 |
| 5 | — | 端到端验收脚本、安装包、备份与卸载说明 | 见「验收」 |
| 6 | — | `/simplify`、`/code-review` 修复；更新 backlog、findings；写 `docs/pr/` | 自查问题已修复或记录 |

### 1. P1-01 工程骨架与 Windows CI

- **CI**：GitHub Actions，`windows-latest` 为必过，`macos-latest` 同时跑（只跑 build 和离线测试，不跑 Electron）。步骤：`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → 许可证检查。全部离线，不碰真实 Codex 或飞书。
- **许可证检查**：新增 `scripts/check-licenses.mjs`，遍历生产依赖的 `package.json`，只允许 MIT / ISC / BSD-2/3 / Apache-2.0 / 0BSD / BlueOak 等允许闭源分发的许可证，出现 GPL / AGPL / LGPL / 无许可证即失败。不引入额外依赖。
- **测试分层**：`pnpm test` 只跑离线测试；真实执行器测试放在 `*.live.test.ts`，需 `PALDOCK_LIVE_CODEX=1` 才运行，默认跳过。
- **vitest 别名补全**：现在只登记了 5 个包，新增包在 `vitest.config.ts` 自动生成别名，避免漏登记。
- 仓库未配置远程 CI 的运行结果我无法在本机验证；工作流文件写好后由用户推送，CI 第一次运行的结果作为验收依据。

### 2. P1-02 会话 / 任务持久化与迁移

新增迁移 `002-p1-sessions-runs.ts`（001 已发布，不修改）：

| 表 / 变更 | 用途 |
|---|---|
| `tasks` 加 `goal`、`check_command`（可空）、`idempotency_key`（可空，唯一部分索引） | 任务目标和可选检查命令；重复提交同一请求只建一次任务 |
| `sessions`（`kind` main/agent、`parent_id`、`workspace_id`、`role`） | PalDock 助手会话；P1 每个子任务一个 agent 会话 |
| `runtime_sessions`（`session_id`、`runtime`、`native_id`） | 原生会话 ID（Codex thread），与 PalDock 会话分开存 |
| `runs` 加 `session_id`、`worktree_path`、`branch`、`failure_reason` | 每次 Run 的执行位置与失败原因 |
| `run_results`（`run_id` 主键、`final_message`、`diff_stat`、`check_exit_code`、`check_output`、`collected_at`） | 每次 Run 的证据；退回重做后旧 Run 的证据保留 |
| `approvals` 加 `native_request_id`、`kind`、`cwd`、`detail` | 回复执行器时要原样带回的请求 ID 和展示用的命令/改动摘要 |
| `run_reviews`（`run_id`、`decision` accept/rework、`note`、`decided_at`） | 验收或退回的意见绑定到产生证据的那次 Run |

要点：

- 流式输出只走临时事件；Run 结束或每 N 秒的检查点合并成一条 `messages` 记录（`session_id` 为该 agent 会话），中途崩溃最多丢最后一段未落库的片段。
- 「待我处理」视图更新：`review` 条目直达最新 Run 的证据；新增 `interrupted_run`（服务重启后被中断、等用户选择恢复或放弃的 Run）。视图改动在新迁移里 `DROP VIEW` 后重建。
- 所有新查询都配条件逐字一致的部分索引，并在测试里用 `EXPLAIN QUERY PLAN` 断言；写入用 `RETURNING`。
- **幂等**：`task.create` 带客户端生成的 `idempotencyKey`，重复请求返回已建任务；审批决定、验收决定靠 `version` 防重放。
- **备份**：新增命令 `maintenance.backup`，用 online backup 写到 `<数据根>/backups/manual-<时间>.db`；恢复方法写进运维说明（停服务，复制回 `paldock.db`）。测试覆盖备份后可打开、数据一致。
- **恢复程序扩展**：服务启动时 `running` 等活动 Run 置为 `interrupted`（已有），同时把对应子任务置为 `blocked` 并附原因，于是出现在「待我处理」里，用户可选择「恢复」（按 thread ID `thread/resume` 后发一条续做的 turn）或「放弃」。挂起的审批一律 `cancelled`（重启后执行器侧的请求已失效）。

### 3. P1-03 Codex 运行时适配器

新包结构：

```text
packages/runtime-codex/src/
  json-rpc.ts          已有，补超时和服务端请求的回复
  launcher.ts          找到 codex.js；以白名单环境变量启动 app-server；结束整个进程树
  codex-adapter.ts     实现 contracts 的 RuntimeAdapter：start/resume/cancel/respondApproval/dispose
  event-mapping.ts     Codex 通知 → RuntimeEvent（纯函数，单测覆盖）
  mock-app-server.ts   离线模拟 app-server：按脚本回放流式、审批、完成、失败、崩溃
packages/application/src/   新包：用例层，不依赖 Electron/SQLite 具体实现以外的东西（只依赖 storage 的接口）
  run-supervisor.ts    启动 Run、接收执行器事件、写状态与事件、处理取消和断线
  approvals.ts         执行器审批请求 → 风险分级 → Approval；用户决定 → 回复执行器；过期即拒绝
  worktrees.ts         建 / 删 worktree（统一带 -c core.longpaths=true，分支名小写 slug）
  evidence.ts          Run 结束后收集改动统计、最终回复、运行检查命令
```

P0 发现的问题在这里落实：

- **进程树**：取消或退出时用 `taskkill /T /F` 结束整棵树（macOS 结束进程组）。Job Object 需要原生扩展，P1 不做，记录为已知限制。
- **中断时机**：`cancel` 在收到 `turn/started` 之前只记下「要取消」，收到后立即发 `turn/interrupt`；若一直没开始，到超时就直接结束进程树。
- **环境变量白名单**：只传 `PATH`、`SYSTEMROOT`、`USERPROFILE`、`HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`/`TMP`、`CODEX_HOME` 等必需项，不继承 `CLAUDE_*`、`ELECTRON_*` 及其他。
- **在 Electron 内启动**：用 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 跑 `codex.js`（P0 未实测，P1 实测）。
- **沙箱**：thread 用 `sandbox: workspace-write`、`approvalPolicy: on-request`，`cwd` 为 worktree，网络关闭。尝试为 Run 关闭用户配置的 MCP 服务器以缩短首轮耗时（需实测可行的参数，不行就记录）。
- **断线**：app-server 意外退出时 Run 进入 `unconfirmed`（「执行状态待确认」），适配器重启 app-server 并 `thread/read` / `thread/resume` 查实：查到已完成就标完成，查不到就标 `interrupted` 交给用户，不猜测。
- **审批**：`item/commandExecution/requestApproval` 和 `item/fileChange/requestApproval` 映射为 Approval；风险按策略引擎判定（worktree 内写和测试为低，联网和装依赖为中，其余为高），不采信模型自报。决定只支持「本次允许」和「拒绝」；「本会话允许」P1 不开放。
- **测试**：适配器对 mock app-server 跑契约测试（流式、审批允许/拒绝、取消前后、崩溃、恢复、版本不符）；真实 Codex 一条 opt-in 测试。

### 4. P1-04 桌面管理界面

渲染进程继续不用框架：TypeScript 编译成浏览器 ES 模块，按页面分文件（`views/attention.ts`、`views/tasks.ts`、`views/task-detail.ts`、`views/new-task.ts`），一个很小的 `store.ts` 负责事件订阅和按需刷新。不引入 React 等依赖，保持 CSP 严格。

- **首页「待我处理」**：审批、待验收、阻塞、执行状态待确认、被中断的 Run，按时间排序；未读加粗，点开记已读但不移除；每条点击直达对应对象。
- **任务列表**：按状态分组，显示项目、最新 Run 状态、更新时间。
- **任务详情**：目标、分支与 worktree 路径、按时间列出各次 Run（执行器、原生会话 ID、状态、用时）；当前 Run 流式输出；审批卡片（命令/改动摘要、目录、风险、过期时间，允许/拒绝）；证据（改动统计、最终回复、检查结果）；操作：取消、验收、退回重做（填原因）、恢复/放弃被中断的 Run。
- **新建任务**：选项目文件夹（主进程 `dialog`，校验是 git 仓库且不在系统目录）、写目标、可选检查命令。
- **连接状态**：服务断线、重启中、执行器断线（「执行状态待确认」）在页头常驻提示，用 `aria-live` 播报。
- **可访问性**：语义化标签、可全键盘操作、焦点可见、颜色不是唯一的状态提示。
- preload 仍只暴露少量方法；新增命令都在 `contracts` 的命令登记表里登记，主进程照旧只转发登记过的命令。选文件夹由主进程弹窗，渲染进程拿不到任意路径读写能力。

## 验收

### 自动化（离线，进 CI）

用 mock app-server 和临时 git 仓库，在 `tests/integration/` 里覆盖：

| 场景 | 期望 |
|---|---|
| 正常流程 | 建任务 → worktree 建好 → Run 流式输出 → 完成 → 子任务 `review`，证据含改动统计和检查结果 → 验收后 `succeeded` |
| 拒绝审批 | 执行器收到 `decline`，Run 正常结束，worktree 内无对应写入；「待我处理」只移除这条审批 |
| 审批过期 | 到期自动拒绝并回复执行器 |
| 取消 | 开始前、执行中、等待审批时取消，进程树全部退出，Run 与任务为 `cancelled` |
| 执行器崩溃 | Run → `unconfirmed` → 查实后更新，界面有提示 |
| 服务崩溃重启 | 活动 Run → `interrupted`，子任务进入「待我处理」；恢复后按 thread ID 续做，放弃后为 `failed` |
| 重复启动 | 第二个服务 `fatal/locked` 退出（已有）；同一 `idempotencyKey` 的建任务只建一次 |
| A/B 场景（02「待我处理」） | A 停在审批、B 交付；打开 A 后重启仍待审批；拒绝 A 只移除 A；退回 B 重跑后旧证据可查，新 Run 成为当前验收对象 |
| 备份 | 手动备份可打开、与原库一致；迁移前自动备份（已有） |

### Electron 实机（本机脚本，扩展 `scripts/p0/electron-check.mjs` 为 `scripts/p1/e2e-check.mjs`）

用 CDP 驱动真实窗口，模拟执行器跑完上表的主要路径，并覆盖强杀服务后界面自动恢复、第二实例退出、正常退出清理。

### 真实 Codex（opt-in，消耗少量额度）

在临时测试仓库里让 Codex 做一个很小的改动（如新建一个文件），走一遍：建任务 → 审批 → 完成 → 回显 → 验收；再测一次中途取消。预计两到三次短对话的额度。

### 安装、备份与卸载

- **安装包**：用 electron-builder（MIT）打 Windows NSIS 安装包，允许用户选择安装目录（可选 D 盘），不签名（开发预览）。如果 electron-builder 的二进制下载在本机镜像上太慢，退一步打可解压即用的 zip。
- **说明文档** `docs/ops/backup-and-uninstall.md`：数据根里有什么、怎么手动备份和恢复、卸载会删什么不删什么（卸载程序不删数据根、worktree 和凭据；给出手动清理的步骤，包括 userData 下的 `bootstrap.json`、`git worktree prune`）。

## 代码质量约定（用户要求）

- 合理分包：`domain` 不依赖任何实现；`application` 只依赖 `domain`、`contracts` 和仓储接口；SQLite 只在 `storage-sqlite`，Electron 只在 `apps/desktop`，Codex 只在 `runtime-codex`。
- 方法短小、命名直白；SQL 写成常量，部分索引条件与查询逐字一致，测试用 `EXPLAIN QUERY PLAN` 固定。
- 写入后需要结果时用 `RETURNING`，不再回查；预编译语句按 SQL 缓存复用。
- 只引入允许闭源分发的依赖，新增依赖在计划外的需在 `docs/pr/` 说明。

## 占位默认值（集中定义，后续可改）

审批过期 30 分钟；取消后等待 `turn/started` 最多 10 秒再强制结束；断线查实重试 3 次、间隔 2 秒；流式输出检查点 5 秒；检查命令超时 10 分钟、输出摘要保留末尾 4 KB；worktree 分支前缀 `paldock/`。

## 不在本次范围

协调助手与计划确认、MCP 桥、Claude 适配器、外部渠道、托盘与开机自启、桌宠、代码签名、自动合并分支、「本会话允许」、自动处理记录单页面。

## 需要你确认的几点

1. **P1 简化为「一个任务一个开发子任务、用户直接写目标」**，不做协调助手。这样 P1 能尽快在真实仓库上跑通；协调和拆任务放到 P3。
2. **真实 Codex 测试会消耗少量额度**（约两到三次短对话），我会在离线测试全部通过后再跑。
3. **安装包用 electron-builder 打 NSIS**，本机下载太慢时退为 zip。
4. **推送**：本机不能 `git push`，完成后我会把推送命令发给你。
