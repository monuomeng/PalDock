# P1 开发计划：本地最小产品

状态：**已完成（2026-11-23），待评审**；第四版经用户批准后实施，实际结果与出入见 [P1 变更说明](../pr/p1-local-mvp.md)。原状态：第四版，待用户确认开工（2026-11-23；已按 Codex 的审阅意见修订，见文末「修订记录」）。负责人：Claude；分支 `claude/project-thread-8azrof`，基于已合入 master 的 P0（`d0d9cd0`）。设计依据见 [架构](../02-architecture.md)、[ADR 0002](../adr/0002-process-topology-and-task-board.md)、[路线图](../03-roadmap.md) 和 [P0 实测记录](../p0/findings.md)；完成后的前因后果写在 `docs/pr/p1-local-mvp.md`。

## 目标

做出一个可安装的开发预览：用户在管理窗口选一个本地 git 仓库，新建任务，PalDock 在独立 worktree 里启动 Codex 执行，界面流式回显输出、弹出审批、显示结果和改动，用户验收或退回重做。「待我处理」是首页。

退出条件（路线图 P1）：在临时测试仓库里从建任务到执行再到回显跑通；拒绝、取消、崩溃重启、重复启动都有测试；备份和卸载有说明。

## P1 的范围取舍

为了在 P1 先打通一条完整的链路，下面几处有意做简化，后续阶段再扩展：

1. **一个任务一个子任务**。用户建任务时直接写目标，服务自动建一个「开发助手」子任务。P1 没有协调助手和 `propose_plan`，也没有 MCP 桥（P3 做）。表结构仍保留 Task / Subtask / Run 三层，以后不用改表。
2. **执行器只有 Codex**，另加一个离线的模拟执行器（mock app-server）给测试和 CI 用。Claude 适配器在 P3。
3. **审批只在桌面**。没有外部渠道，也就没有升级；审批有过期时间（占位 30 分钟），过期即拒绝。
4. **验收由用户点按钮**。服务在 Run 结束后自动收集证据：git 改动统计、最终回复、用户在建任务时可选填的检查命令（如 `pnpm test`），建任务时确认一次后，每次 Run 结束自动受控运行，记录退出码、用时和脱敏后的输出。服务不自动合并分支，只显示分支名，合并由用户自己做。
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

- **CI**：GitHub Actions，`windows-latest` 为必过，`macos-latest` 同时跑（只跑 build 和离线测试，不跑 Electron）。步骤：`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → 许可证检查。安装依赖需要联网；测试本身不访问真实模型和 IM。
- **许可证检查**：新增 `scripts/check-licenses.mjs`，以 `pnpm licenses list --prod --json` 取得全部生产依赖（含传递依赖），按 SPDX 表达式判定：`OR` 只要有一支允许即可，`AND` 要求每一支都允许，`WITH` 例外单独登记；允许列表为 MIT / ISC / BSD-2-Clause / BSD-3-Clause / Apache-2.0 / 0BSD / BlueOak-1.0.0 等允许闭源分发的许可证。GPL / AGPL / LGPL、无许可证、无法解析的表达式都判失败，确需例外的包在脚本里逐个登记并写明理由。不引入额外依赖。
- **测试分层**：`pnpm test` 只跑离线测试；真实执行器测试放在 `*.live.test.ts`，需 `PALDOCK_LIVE_CODEX=1` 才运行，默认跳过。
- **vitest 别名补全**：现在只登记了 5 个包，新增包在 `vitest.config.ts` 自动生成别名，避免漏登记。
- 仓库未配置远程 CI 的运行结果我无法在本机验证；工作流文件写好后由用户推送，CI 第一次运行的结果作为验收依据。

### 2. P1-02 会话 / 任务持久化与迁移

新增迁移 `002-p1-sessions-runs.ts`（001 已发布，不修改）：

| 表 / 变更 | 用途 |
|---|---|
| `tasks` 加 `goal`、`check_command`（可空，JSON：`{ executable, args[] }`）、`check_confirmed_at`（可空）、`idempotency_key`（可空，唯一部分索引） | 任务目标和可选检查命令；重复提交同一请求只建一次任务 |
| `sessions`（`kind` main/agent、`parent_id`、`workspace_id`、`role`） | PalDock 助手会话；P1 每个子任务一个 agent 会话 |
| `runtime_sessions`（`session_id`、`runtime`、`native_id`） | 原生会话 ID（Codex thread），与 PalDock 会话分开存 |
| `runs` 加 `session_id`、`native_thread_id`、`native_turn_id`、`resumes_run_id`（可空）、`worktree_path`、`branch`、`failure_reason` | 每次 Run 的执行位置与失败原因。一次 Run 只对应一个 turn，`native_turn_id` 写入后不再修改；续做时新建 Run 并用 `resumes_run_id` 指向被续做的那次，原 Run 的记录原样保留 |
| `run_results`（`run_id` 主键、`final_message`、`diff_stat`、`check_exit_code`、`check_duration_ms`、`check_output_ref`、`collected_at`） | 每次 Run 的证据；退回重做后旧 Run 的证据保留。检查命令的完整输出脱敏后存为 `artifacts/` 下的文件，库里只存引用 |
| `approvals` 加 `native_request_id`、`kind`（command / file_change / permissions / other）、`cwd`、`detail` | 回复执行器时要原样带回的请求 ID 和展示用的命令/改动摘要 |
| `run_reviews`（`run_id`、`decision` accept/rework、`note`、`decided_at`） | 验收或退回的意见绑定到产生证据的那次 Run |

要点：

- 流式输出只走临时事件；Run 结束或每 N 秒的检查点合并成一条 `messages` 记录（`session_id` 为该 agent 会话），中途崩溃最多丢最后一段未落库的片段。
- 「待我处理」视图更新：`review` 和 `blocked` 条目都直达该子任务最新那次 Run（证据或中断原因）；被中断的 Run 不单设条目类型，经子任务 `blocked` 出现。视图改动在新迁移里 `DROP VIEW` 后重建。
- 所有新查询都配条件逐字一致的部分索引，并在测试里用 `EXPLAIN QUERY PLAN` 断言；写入用 `RETURNING`。
- **幂等**：`task.create` 带客户端生成的 `idempotencyKey`，重复请求返回已建任务；审批决定、验收决定靠 `version` 防重放。
- **备份**：新增命令 `maintenance.backup`，写到 `<数据根>/backups/manual-<时间>/`，内含数据库（online backup）和 `artifacts/` 的完整副本。先复制产物、再备份数据库，保证库里引用的文件都在备份中。测试覆盖：备份可打开、数据一致、库中引用的每个产物文件都在备份里。
  - **不在备份范围内**：worktree（未提交的改动不备份；已提交的内容在用户仓库的 `paldock/` 分支里）、Codex 原生会话（在 Codex 自己的历史目录里，恢复后旧 Run 可能无法再 resume）、凭据（在系统凭据库）。迁移前的自动备份只含数据库，这一点在说明里写明。
  - **恢复**：停服务后用备份中的数据库和 `artifacts/` 整体替换。服务启动时若发现库中引用的产物文件不存在，在证据处显示「证据文件缺失」，不报错退出。
- **审批在什么情况下保留**：只关闭或重建窗口、服务一直存活时，挂起的审批原样保留，重新打开后仍待审批。服务重启或执行器进程重启后，执行器侧的请求已经失效，旧审批一律置为 `cancelled`（原因写明「服务重启」或「执行器重启」）；Run 恢复执行后，执行器若仍要做那个操作，会重新发起请求，生成一条新的审批。
- **恢复程序扩展**：服务启动时 `running` 等活动 Run 置为 `interrupted`（已有），同时把对应子任务置为 `blocked` 并附原因，于是出现在「待我处理」里（作为阻塞条目，直达该子任务最新的那次 Run），用户可选择：
  - 「恢复」：新建一次 Run，`resumes_run_id` 指向被中断的 Run，按同一 thread ID `thread/resume` 后发一条续做的 turn；被中断的 Run 保持 `interrupted`，它的 turn 和证据都不改；
  - 「重新开始」：新建一次 Run 和新的 thread，旧 Run 的会话和证据保留；
  - 「放弃」：子任务为 `failed`。
- **恢复失败不静默新建**：`thread/resume` 失败时 Run 保持 `interrupted`，界面明确提示恢复失败的原因，只给「重新开始」和「放弃」两个选项。不自动换成新 thread，避免上下文和审批边界在用户不知情时改变。`contracts/runtime.ts` 里「恢复失败再新建」的注释同步改掉。

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
  evidence.ts          Run 结束后收集改动统计、最终回复，经 check-runner 运行检查命令
  check-runner.ts      受控运行用户填写的检查命令（见下）
```

**检查命令受控执行**。检查命令（如 `pnpm test`）会执行项目里的任意脚本，而且是由服务直接启动、不经 Codex 的沙箱和审批，所以按下面的规则处理：

- **谁授权**：命令只能由用户在桌面新建任务时亲手填写，执行器和模型不能设置或修改它。建任务时界面显示完整命令、工作目录和「以你的账户权限运行、可联网」的提示，用户确认一次即可，之后每次 Run 结束都自动运行；命令被修改后需重新确认，确认记录（时间、命令）存在任务上。未确认的命令不会运行，证据里记「未运行检查」。
- **工作目录**：固定为这次 Run 的 worktree，路径经规范化后必须位于数据根的 `worktrees/` 下。
- **命令格式**：结构化存储为「可执行文件 + 参数数组」，不做任何字符串拆分。新建任务时界面分两栏填写：可执行文件一栏，参数每行一个。不支持管道、重定向、环境变量展开等 shell 语法，需要时由用户写成项目里的脚本。
- **支持范围**：可执行文件可以是绝对路径，或在 PATH（白名单环境里的 PATH）上按名字查找。`.exe` 及 macOS 上的可执行文件直接以 `spawn(file, args, { shell: false })` 启动，参数原样传入。Windows 上的 `.cmd` / `.bat`（如 `pnpm.cmd`）Node 不允许直接启动，经 `cmd.exe /d /s /c` 并按 cmd 的规则给每个参数加引号转义；cmd 无法安全转义 `%`、`!`、`"` 和换行，含这些字符的参数直接拒绝并提示原因。
- **测试**：带空格的可执行文件路径和参数、中文路径、`&|<>^()` 等 cmd 元字符、被拒绝的 `%` 与 `"`，在 Windows 上逐项验证参数原样到达。
- **环境变量**：与执行器同一份白名单，另加 `CI=1`；不传 PalDock 自身的令牌、管道名和任何凭据。
- **权限的限度**：P1 没有操作系统级沙箱，检查命令以当前用户身份运行，可以联网、可以访问用户能访问的文件。这一点在审批卡片和文档里写明，由用户决定是否运行。
- **取消与超时**：任务取消或超时（占位 10 分钟）时结束整个进程树（Windows `taskkill /T /F`，macOS 进程组）；服务退出时同样清理。
- **输出处理**：输出可能含凭据。先按常见格式脱敏（`Bearer` 令牌、`sk-`/`ghp_`/`xox` 等前缀密钥、`password=`/`token=` 一类键值、PEM 私钥块），完整输出（上限 1 MB，超出截断并注明）写入 `artifacts/` 下的文件，库里只存文件引用、退出码和用时；界面默认折叠，展开时才读文件。日志和事件里不出现检查输出。

P0 发现的问题在这里落实：

- **进程树**：取消或退出时用 `taskkill /T /F` 结束整棵树（macOS 结束进程组）。Job Object 需要原生扩展，P1 不做，记录为已知限制。
- **中断时机**：`cancel` 在收到 `turn/started` 之前只记下「要取消」，收到后立即发 `turn/interrupt`；若一直没开始，到超时就直接结束进程树。
- **环境变量白名单**：只传 `PATH`、`SYSTEMROOT`、`USERPROFILE`、`HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`/`TMP`、`CODEX_HOME` 等必需项，不继承 `CLAUDE_*`、`ELECTRON_*` 及其他。
- **在 Electron 内启动**：用 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 跑 `codex.js`（P0 未实测，P1 实测）。
- **沙箱**：thread 用 `sandbox: workspace-write`、`approvalPolicy: on-request`，`cwd` 为 worktree，网络关闭。尝试为 Run 关闭用户配置的 MCP 服务器以缩短首轮耗时（需实测可行的参数，不行就记录）。
- **断线**：app-server 意外退出时 Run 进入 `unconfirmed`（「执行状态待确认」），挂起的审批置为 `cancelled`。适配器重启 app-server，`thread/read` 读出该 thread 的 turn 列表，**只看这次 Run 记录的 `native_turn_id` 那一个 turn**：它有明确终态（completed / failed / interrupted）才据此更新 Run 并收集证据；找不到这个 turn、或它仍是 inProgress 而执行器已不在，就保持 `unconfirmed`，重试查实（占位 3 次）后仍无法确认则转为 `interrupted` 交给用户。不拿同一 thread 里前几次 Run 的结果当作这次的结果。若 `turn/started` 前就断线、还没拿到 turn ID，直接视为无法确认。
- **审批**：执行器发来的服务端请求分三类处理，任何一类都不会让执行器无限等待：
  - `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`：映射为 Approval，风险按策略引擎判定（worktree 内写和测试为低，联网和装依赖为中，其余为高），不采信模型自报；
  - `item/permissions/requestApproval`（权限扩展，例如要求放开沙箱或联网）：P1 一律视为高风险，界面展示请求的具体权限；在回复格式实测确认之前，只提供「拒绝」，并在 Approval 上记明原因；
  - 未知的服务端请求：立即以 JSON-RPC 错误回复（等同拒绝），在 Run 上写一条「收到未识别的请求」事件，不阻塞 turn。
  - 决定只支持「本次允许」和「拒绝」；「本会话允许」P1 不开放。审批过期（占位 30 分钟）、任务取消、Run 结束时，仍挂起的审批都会回复执行器拒绝或取消。
- **测试**：适配器对 mock app-server 跑契约测试（流式、审批允许/拒绝、取消前后、崩溃、恢复、版本不符）；真实 Codex 一条 opt-in 测试。

### 4. P1-04 桌面管理界面

渲染进程继续不用框架：TypeScript 编译成浏览器 ES 模块，按页面分文件（`views/attention.ts`、`views/tasks.ts`、`views/task-detail.ts`、`views/new-task.ts`），一个很小的 `store.ts` 负责事件订阅和按需刷新。不引入 React 等依赖，保持 CSP 严格。

- **首页「待我处理」**：审批、待验收、阻塞（含服务重启后被中断、等你选择的任务）、执行状态待确认，按时间排序；未读加粗，点开记已读但不移除；每条点击直达对应对象。
- **任务列表**：按状态分组，显示项目、最新 Run 状态、更新时间。
- **任务详情**：目标、分支与 worktree 路径、按时间列出各次 Run（执行器、原生会话 ID、状态、用时）；当前 Run 流式输出；审批卡片（命令/改动摘要、目录、风险、过期时间，允许/拒绝）；证据（改动统计、最终回复、检查结果）；操作：取消、验收、退回重做（填原因）、对被中断的 Run 选择恢复、重新开始或放弃。
- **新建任务**：选项目文件夹（主进程 `dialog`，校验是 git 仓库且不在系统目录）、写目标、可选检查命令（可执行文件和参数分栏填写）。
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
| 权限扩展与未知请求 | `permissions` 请求显示为高风险、只能拒绝；未知请求立即收到错误回复，turn 不挂起 |
| 检查命令 | 未确认不运行、确认后每次 Run 自动运行、修改后需重新确认；工作目录在 worktree 内；取消时进程树全部退出；输出里的模拟令牌被脱敏，库和日志中不出现 |
| 执行器崩溃 | Run → `unconfirmed`，挂起审批被取消；当前 turn 有明确终态才更新；mock 里同一 thread 的上一个 turn 已完成、当前 turn 查不到时，Run 不被误判为完成 |
| 服务崩溃重启 | 活动 Run → `interrupted`，挂起审批 → `cancelled`，子任务进入「待我处理」；「恢复」新建一次 Run 续做同一 thread、旧 Run 的 turn 与证据不变，「重新开始」新建 Run 和新 thread 且旧证据保留，「放弃」为 `failed`；恢复失败时只给后两个选项，不静默新建 |
| 重复启动 | 第二个服务 `fatal/locked` 退出（已有）；同一 `idempotencyKey` 的建任务只建一次 |
| A/B 场景（02「待我处理」） | A 停在审批、B 交付。打开 A 后关闭并重开窗口（服务存活），A 仍待审批；拒绝 A 只移除 A 的审批。重启服务后，A 的旧审批为已取消，A 改以阻塞条目（原因为服务重启）出现，仍定位到同一任务，B 的待验收不变；退回 B 重跑后旧证据可查，新 Run 成为当前验收对象 |
| 备份 | 手动备份含数据库与产物，可打开且与原库一致，库中引用的产物都在；从备份恢复后证据可查；删掉一个产物文件后界面显示「证据文件缺失」；迁移前自动备份（已有，只含数据库） |

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

审批过期 30 分钟；取消后等待 `turn/started` 最多 10 秒再强制结束；断线查实重试 3 次、间隔 2 秒；流式输出检查点 5 秒；检查命令超时 10 分钟、输出文件上限 1 MB；worktree 分支前缀 `paldock/`。

## 不在本次范围

协调助手与计划确认、MCP 桥、Claude 适配器、外部渠道、托盘与开机自启、桌宠、代码签名、自动合并分支、「本会话允许」、自动处理记录单页面。

## 需要你确认的几点

1. **P1 简化为「一个任务一个开发子任务、用户直接写目标」**，不做协调助手。这样 P1 能尽快在真实仓库上跑通；协调和拆任务放到 P3。
2. **真实 Codex 测试会消耗少量额度**（约两到三次短对话），我会在离线测试全部通过后再跑。
3. **安装包用 electron-builder 打 NSIS**，本机下载太慢时退为 zip。
4. **推送**：本机不能 `git push`，完成后我会把推送命令发给你。

## 修订记录

**第二版（2026-11-23）**，按 Codex 的审阅意见修订：

1. 审批在重启后的规则：只重建窗口时保留；服务或执行器重启后旧审批取消，恢复执行后重新请求。A/B 验收场景随之改写，不再前后矛盾。
2. 检查命令改为受控执行：需审批后运行，固定工作目录、参数数组启动、环境变量白名单、超时与进程树清理；输出脱敏后存文件，库里只存引用。写明 P1 没有操作系统级沙箱。
3. 断线和重启恢复按 `runId → thread ID → turn ID` 核对，只认这次 Run 自己的 turn 终态，无法确认就保持待确认。
4. 审批补上 `item/permissions/requestApproval`（高风险、P1 只能拒绝）和未知请求（立即错误回复），保证执行器不会一直等待。
5. 恢复失败不再静默新建 thread：提示用户，由用户选择「重新开始」（新 Run，旧证据保留）或「放弃」。
6. CI 表述改为「安装需联网，测试不访问真实模型和 IM」；许可证检查覆盖传递依赖并按 SPDX 表达式判定。

**第三版（2026-11-23）**，按 Codex 的第二轮意见修订：

1. 续做不再覆盖原 Run 的 turn ID：「恢复」新建一次 Run，用 `resumes_run_id` 关联被中断的那次，每次 Run 只对应一个 turn。「待我处理」不再单设「被中断的 Run」类型，统一作为阻塞的子任务出现。
2. 手动备份包含数据库和 `artifacts/`，附文件清单；写明 worktree、Codex 原生会话和凭据不在备份范围内，迁移前自动备份只含数据库；恢复后缺失的证据文件如实显示。
3. 检查命令改为结构化的「可执行文件 + 参数数组」，不按空白拆分；写明 `.exe` 与 Windows `.cmd` 的支持范围和拒绝的字符，并列出带空格路径与特殊字符的测试。

**第四版（2026-11-23）**，与用户商量后确定：

1. 去掉第三版加的备份 `manifest.json`，手动备份只含数据库和 `artifacts/`。
2. 检查命令保留对 Windows `.cmd` 的支持（`pnpm`、`npm` 都是 `.cmd`），按第三版的转义与拒绝字符规则处理。
3. 检查命令不再每次 Run 都审批：建任务时确认一次，命令修改后重新确认（第二版的「每次审批」是 Claude 自己加的，不是审阅意见）。
