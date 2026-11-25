# P0 实测记录

记录时间 2026-11-23，Windows 11（10.0.26200，x64），Node 26.7.0（开发与测试），Electron 45.2.3（主机运行时）。只记录实际跑过的结果；未运行的项明确标注。计划见 [P0 开发计划](../plan/p0-technical-validation.md)。

## 结论一览

| 积压 ID | 项目 | 结果 |
|---|---|---|
| P0-01 | Codex app-server 能力 | 通过：发现、initialize、账号、thread、流式、中断、审批请求、跨进程恢复均已实测（2026-11-23 经用户同意跑了计费项）；app-server 在 turn 中途崩溃的恢复未测 |
| P0-02 | Claude Code SDK/CLI | 通过（CLI stream-json）：流式、中断、权限请求、跨进程恢复均已实测；Agent SDK 未单独评估。桌面版自带 Claude Code 2.1.325（`%LOCALAPPDATA%\Claude-Data\…\claude-code\2.1.325\…\claude.exe`）），需单独登录 |
| P0-03 | 飞书长连接 | 通过（单聊）：用户自建测试应用，长连接、接收、回复、断线补投与去重已实测；群聊、卡片未测 |
| P0-04 | Electron + SQLite + 受限 IPC | 通过（Windows）：存储、服务进程、Electron 窗口、看护重启、单实例与正常退出已实测；电源事件、长路径、macOS 未测 |
| P0-05 | 版本化事件与状态机 | 通过：契约与状态机测试见 `packages/contracts`、`packages/domain` |
| P0-06 | 许可证与素材 | 已决定（2026-11-23）：暂不开源。仓库保持私有、不放开源许可证；只引入允许闭源分发的依赖（MIT / Apache-2.0 / BSD 等），不复制 GPL / AGPL 代码（Coopanion 只借鉴设计）。桌宠素材来源待定 |
| P0-07 | Codex / Claude / ACP 子代理对比 | 通过（Codex、Claude 实测）；ACP 只做了文档评估，未运行 |

自动化测试：`pnpm test` 共 44 项通过，`pnpm build`（`tsc -b` 严格模式）通过。

## P0-01 Codex app-server

运行方式：`pnpm build` 后执行 `node packages/runtime-codex/dist/probe.js`（零成本），`--turn` / `--interrupt` 为 opt-in。

| 项 | 实测 |
|---|---|
| 版本 | codex-cli 0.166.0，npm 安装（`D:\software\codex-cli`） |
| 发现 | Windows 上 PATH 里只有 `codex.cmd` 外壳；Node 不允许不经 shell 启动 `.cmd`，改为用 Node 运行 `node_modules/@openai/codex/bin/codex.js`。在 Electron 内需传 Electron 可执行文件并设 `ELECTRON_RUN_AS_NODE=1`（未实测） |
| 传输 | `codex app-server --listen stdio://`，按行分隔 JSON-RPC；消息不带 `jsonrpc` 字段，客户端两种都接受 |
| initialize | 通过；返回 userAgent、codexHome、platformOs；之后需发 `initialized` 通知 |
| 账号 | `account/read` 返回 `chatgpt` 类型（未记录邮箱） |
| 模型 | `model/list` 返回 9 个 |
| thread/start | `ephemeral: true`、`sandbox: read-only`、`approvalPolicy: on-request` 成功，返回的 sandbox 为 `readOnly`、无网络 |
| 协议面 | `generate-ts` 生成 97 个顶层类型 + 664 个 v2 类型。关键方法：`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、`turn/steer`；审批为服务端请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`，决定值 `accept / acceptForSession / decline / cancel` 及策略修订；完成通知 `turn/completed`（状态 `completed / interrupted / failed / inProgress`）；流式 `item/agentMessage/delta` |
| 进程树 | **重要**：只结束外层 node 进程时，内层 `codex.exe` 仍持有 stdout 管道和工作目录句柄，导致探测进程挂起、临时目录删除报 EPERM。改用 `taskkill /T /F` 结束整树后正常（`packages/platform/src/process-tree.ts`）。P1 评估 Job Object |

计费项实测（`probe.js --turn --interrupt --approval --resume`，2026-11-23）：

| 项 | 结果 |
|---|---|
| 流式与完成 | 极短回复 turn 用时 26–42 秒（含 MCP 服务器启动），`item/agentMessage/delta` 1 次后 `turn/completed`（`completed`）；较长回复 27 次 delta |
| 中断 | `turn/start` 返回时 turn 不一定已开始，立刻 `turn/interrupt` 会报 `no active turn to interrupt`；等到 `turn/started` 通知再中断，58 ms 后收到 `turn/completed`（`interrupted`）。适配器必须以 `turn/started` 为准 |
| 审批 | 只读沙箱 + `on-request` 下要求写文件，收到服务端请求 `item/commandExecution/requestApproval`；回复 `decline` 后 turn 正常结束（`completed`），没有写入 |
| 跨进程恢复 | 非 ephemeral thread 跑完一轮后结束 app-server，新进程 `thread/resume` 返回同一 thread、加载 3 个历史 turn，随后新 turn 正常完成。副作用：在 Codex 历史里留下一条测试会话 |
| 通知面 | 一次 turn 还会收到 `thread/status/changed`、`item/started`/`item/completed`、`thread/tokenUsage/updated`、`account/rateLimits/updated`、`mcpServer/startupStatus/updated`（用户配置的 MCP 服务器每次都会启动，是首轮耗时的主要来源，可考虑为 PalDock 的 Run 关闭无关 MCP） |

尚未验证：app-server 在 turn 进行中崩溃后的恢复、`acceptForSession` 的作用范围、文件改动审批（`item/fileChange/requestApproval`）。

## P0-02 Claude Code（零成本部分）

探测脚本 `node packages/runtime-claude/dist/probe.js [--turn] [--interrupt] [--permission] [--resume]`，经 CLI 的 stream-json 双向流接入。

| 项 | 实测 |
|---|---|
| 发现 | PATH 上没有 `claude`；Claude 桌面版自带 Claude Code 2.1.325，路径含版本号和构建号，桌面版升级后会变，产品中应让用户安装独立的 Claude Code 或在设置里填路径 |
| 登录 | 独立运行时 `auth status` 为未登录（以非零码退出但输出 JSON）：桌面版的登录不会自动给子进程用。未登录时会话仍会输出 `system/init`，随后以「Not logged in」结束 |
| 环境变量 | **重要**：从 Claude 桌面版或另一个 Claude Code 会话里启动子进程时，会继承几十个 `CLAUDE_*` 变量，子进程会挂到宿主会话上（实测带出了宿主的工具列表）。适配器必须用白名单环境变量启动 |
| 隔离参数 | `--strict-mcp-config`、`--setting-sources ""` 可以不加载用户的 MCP 与设置；`--permission-prompt-tool stdio` 让权限请求经 stdout 以 `control_request/can_use_tool` 送到宿主 |

计费项实测（用户为这份 Claude Code 单独登录 claude.ai 账号后，`probe.js --turn --interrupt --permission --resume`，2026-11-23）：

| 项 | 结果 |
|---|---|
| 初始化 | `system/init` 返回 session_id、默认模型、权限模式 `default`、30 个内置工具（隔离参数生效，未加载用户的 MCP） |
| 流式与完成 | 极短回复约 3.3 秒，`--include-partial-messages` 下有 6 个 `stream_event`，以 `result/success` 结束；比 Codex 首轮快一个数量级（没有 MCP 启动开销） |
| 中断 | 收到第一个 `stream_event` 后发 `control_request/interrupt`，9 ms 后以 `result/error_during_execution` 结束。适配器要把这个 subtype 映射为「已中断」而不是失败 |
| 权限请求 | 要求写文件时收到 `control_request/can_use_tool`（工具 `Write`），回复 `deny` 后文件未写入，turn 正常结束 |
| 跨进程恢复 | 结束进程后用 `--resume <session_id>` 启动新进程，模型能答出第一轮的内容。副作用：会话保存在用户的 Claude Code 历史中 |
| 其他消息 | `system/status`、`rate_limit_event`（可用于展示额度） |

与 Codex 对照：两者都支持流式、中断、宿主审批和恢复，可以落到同一个 `RuntimeAdapter` 契约上；差异在于 Codex 审批是 JSON-RPC 服务端请求、按命令/文件改动分类，Claude 是按工具名的 `can_use_tool`，策略引擎需要各自映射到风险级别。

## P0-07 原生子代理与独立会话

探测脚本 `packages/runtime-codex/dist/subagent-probe.js`、`packages/runtime-claude/dist/subagent-probe.js`：让主会话必须用原生子代理读取临时目录里的一个文件，记录宿主能观察到什么（2026-11-23，各消耗一次短对话）。

| 项 | Codex 0.166（默认模型，`multi_agent` 默认开启） | Claude Code 2.1.325 |
|---|---|---|
| 是否可用 | 9 个模型中 8 个报告 `multiAgentVersion` v1/v2 | 内置 `Agent` 工具，默认可用 |
| 用时 | 约 60 秒 | 约 7.7 秒 |
| 创建可见性 | `subAgentActivity` 条目（`started` / `completed`）带子代理 `agentThreadId`；主线程另有 `collabAgentToolCall`（本次只观察到 `wait`，未观察到 `spawnAgent` 条目） | 主会话 `tool_use` 名为 `Agent`；另有 `system/task_started`、`task_progress`、`task_updated`、`task_notification` |
| 子代理过程 | 子代理是独立 thread，它的条目和通知以自己的 threadId 推送给同一个 app-server 客户端（本次通知里出现 2 个 thread） | 加 `--forward-subagent-text` 后，子代理的 user / assistant 消息带 `parent_tool_use_id` 转发给宿主 |
| 审批 | 本次只读操作没有触发审批；子代理审批是否以子 threadId 发来未验证 | 本次 `Read` 未触发权限请求；子代理内的权限请求是否经 `can_use_tool` 发来未验证 |
| 用量 | `thread/tokenUsage/updated` 按 thread 分开上报（主、子各一） | `result` 带 `usage`、`modelUsage`、`total_cost_usd`（订阅账号下为估算值） |
| 控制 | 协议有 `interruptAgent`、`closeAgent`、`resumeAgent` 等工具名，宿主可中断整个 turn | 中断主会话即中断子代理（未单独验证） |

结论：

- 两边的原生子代理都能被宿主观察到，但形态不同。PalDock 按 [ADR 0002](../adr/0002-process-topology-and-task-board.md) 把它们当作该 Run 的内部细节：只记录可见事件（子代理开始/结束、用量），不当作可派单的助手。
- 需要可审计、可恢复、可换执行器的分工，仍走 PalDock 任务板（每个子任务独立 AgentSession / Run），不依赖原生子代理。
- 用量要按「主会话 + 子代理」合计：Codex 按 thread 汇总 `tokenUsage`，Claude 取 `result` 中的 `modelUsage`。
- **ACP**：未运行。Codex 与 Claude 的原生协议已经覆盖 PalDock 需要的流式、中断、审批、恢复和子代理可见性；ACP 需要额外的第三方适配器进程，P1 不采用，以后接入其他只支持 ACP 的 CLI 时再评估。

## P0-03 飞书长连接

探测脚本 `node packages/channel-feishu/dist/probe.js [--minutes N] [--reply] [--bounce]`，官方 SDK `@larksuiteoapi/node-sdk` 1.76.0（MIT）的 WSClient。凭据由用户用 `cmdkey /generic:paldock/feishu` 存入 Windows 凭据管理器，程序经 Win32 CredRead 读入内存，不落盘、不进日志。

| 项 | 实测（2026-11-23，用户的测试租户与自建应用） |
|---|---|
| 建连 | 启动约 0.3 秒 `ready`，无需公网地址；必须先有程序在线，开发者后台才能把订阅方式保存为「长连接」 |
| 接收 | `im.message.receive_v1` 载荷含 `event_id`、`create_time`、`event_type`、`tenant_key`、`app_id`、`sender`、`message`；`event_id` 可直接作为 inbox 去重键 |
| 回复 | 单聊里 `im.v1.message.reply` 成功（code 0），接收到回复约 0.8–1.5 秒 |
| 时钟 | `create_time` 比本机时间晚约 0.6–0.7 秒（负延迟），时间判断不能依赖它与本机时钟的差 |
| 断线补投 | 断开 3 分钟期间发出的 3 条消息，重连后没有立刻推送，而是在各自发送后约 **314 秒**统一补投；配置订阅前发出的消息同样在约 314 秒后补投。补投的消息仍按新事件处理，未见重复投递 |
| 去重 | inbox 放在固定数据根，跨进程重启保留；同一 `event_id` 再次到达会被拒绝（存储侧测试已覆盖） |

对产品的影响：渠道断线恢复后的约 5 分钟内，外部消息可能延迟到达，界面应提示「渠道刚恢复，消息可能延迟」；补投与重试都必须靠 `event_id` 去重。未测：群聊 @ 机器人、交互卡片与 `card.action.trigger`、长时间断线（补投重试次数与上限）。

## P0-04 存储（SQLite）

驱动选择 `node:sqlite`（Node 内置，SQLite 3.53.4）：Electron 45 自带的 Node 同样提供，免去 better-sqlite3 在 Windows 上的原生编译。

- **WAL、外键、busy_timeout**：文件库打开后 `journal_mode = wal` 已验证。
- **FTS5 trigram**：内置构建支持；中文子串「记住我」可检索。trigram 至少 3 个字符，两字中文词（如「周报」）检索不到，已实现 LIKE 回退（全表扫描，数据量大时需在 P2 用向量或 ngram 方案补充）。
- **部分索引**：SQLite 不会从 `status = 'x'` 推出 `status IN (...)`，单值查询选不中 IN 条件的部分索引（`EXPLAIN QUERY PLAN` 实测为 SCAN）。因此每种查询条件各配一个条件逐字一致的部分索引，测试里用 `EXPLAIN QUERY PLAN` 固定下来。
- **RETURNING**：所有插入和状态更新用 `RETURNING` 直接拿回最新行，不回查。
- **迁移**：事务内执行，失败整体回滚；已有数据时先用 `node:sqlite` 的 online backup 备份到 `backups/`（已测）。
- **启动恢复**：未结束的 Run 一条 UPDATE 置为 `interrupted` 并逐条写事件；处理中的 inbox 事件放回队列。
- **inbox**：主键去重，处理完写墓碑（清空 payload），迟到重复事件仍被拒；同一会话串行，租约过期可回收（已测）。

## P0-04 进程与 IPC

用 `scripts/p0/fork-check.mjs` 以 `child_process.fork` 驱动本地服务入口（utilityProcess 的备选路径）实测：

| 场景 | 结果 |
|---|---|
| 启动、迁移、经命名管道 `\\.\pipe\paldock-<随机>` 握手 | 通过 |
| 错误令牌 | 连接被断开，收不到 welcome（自动化测试） |
| 同一数据根第二个服务 | 收到 `fatal/locked`，退出码 75（看护程序据此不重启） |
| 强杀服务后再启动 | 遗留 PID 锁被识别为失效并接管，数据完好 |
| 正常退出 | 收到 `shutdown` 后中断未结束 Run、关闭连接与数据库，退出码 0 |
| 断线续拉 | 客户端带 `afterSeq` 重连，服务先补发事件再发 welcome，connect 返回时已追上（自动化测试） |

## Electron

Electron 45.2.3（内置 Node 24.22.2）。其 `node:sqlite` 为 SQLite 3.53.4，FTS5 trigram 与 online backup 均可用，与开发环境的 Node 26 一致。Electron 45 改为首次运行时下载二进制，经 npmmirror 约 30 KiB/s 且中途断开过一次，最终用 `curl -C -` 续传、按 `checksums.json` 校验后手动解压。

实机验证（`PALDOCK_DATA_ROOT` 指向临时目录，带 `--remote-debugging-port` 以 `scripts/p0/cdp-eval.mjs` 驱动页面）：

| 场景 | 结果 |
|---|---|
| 启动 → utilityProcess 服务就绪 → 主进程经命名管道握手 | 通过，页面显示「已连接」 |
| 渲染进程隔离 | `window.paldock` 只有 4 个方法；`require`、`process` 均为 undefined |
| 命令白名单 | 未登记的命令被主进程拒绝；外键错误以 `not_found` 返回 |
| 新建任务、改状态 | 持久事件 #1、#2 推送到页面 |
| 强杀服务 | **发现问题**：Windows 上被结束的 utilityProcess 退出码为 0，原策略当成正常退出而不重启。已改为只有主进程主动要求的退出才算正常；修复后显示「服务已退出，3 秒后重启」，随后自动重连，新事件序号接续为 #3 |
| 遗留 PID 锁 | 服务被强杀留下的锁在下次启动时被识别为失效并接管 |
| 跨启动持久化 | 重新打开应用后历史事件仍在 |
| 第二个实例 | 立即退出（Electron 单实例锁），不会启动第二个服务 |
| 禁止导航 | 页面内跳转外部网址被阻止，仍停留在 `file:` |
| 正常退出 | 关闭窗口后服务收尾退出，PID 锁删除，WAL 已合并只剩 `paldock.db` |

以上检查已整理成可重复运行的 `node scripts/p0/electron-check.mjs`（14 项，Windows 全部通过）。

**worktree 放在数据根**（`node scripts/p0/worktree-check.mjs`，Windows / git 2.42）：

- 在数据根下创建 worktree、写入并提交 334 字符的深层路径都没有问题（Node 与 git 均可处理）。
- **删除含超长路径的 worktree 时，不开 `core.longpaths` 会报 `Filename too long`，而且 worktree 已被注销、文件残留在磁盘上**；加 `-c core.longpaths=true` 后删除成功。PalDock 对 worktree 的 git 命令应统一带上该参数，不修改用户的全局配置。
- 文件系统不区分大小写：只差大小写的两个分支名（`paldock/Fix-Login` 与 `paldock/fix-login`）不能共存，只差大小写的两个文件会合并成一个。PalDock 生成的分支名应统一用小写 slug；macOS 默认 APFS 同样不区分大小写，待 Mac 测试确认。

未验证：powerMonitor 锁屏 / 空闲事件（已加诊断开关 `PALDOCK_DIAGNOSTICS=1`，事件写入数据根下的 `diagnostics.log`）、开机自启、杀毒软件扫描对 worktree 的影响、macOS 文件夹授权、35 秒强制结束路径（服务没有卡住的场景）。

## macOS

用户只有 Windows 电脑，macOS 由其他人协助测试。测试包是仓库 `git archive` 打出的 zip，附 AI 可执行的手册 [docs/test-kits/macos/README.md](../test-kits/macos/README.md) 和一键脚本 `scripts/macos/run-p0-checks.sh`，结果以 `p0-macos-results.zip` 发回。为 macOS 预先处理的点：Unix 套接字路径超过 `sun_path` 上限（104 字节）时退到 `/tmp/paldock-<哈希>.sock`；执行器进程组整体结束；凭据读取目前只实现了 Windows（macOS 钥匙串待补，测试包不涉及）。

**结果（2026-11-24，macOS 27.0.1 arm64，APFS，Node 26.0.0，git 2.54.0）**：

| 项 | 结果 |
|---|---|
| Electron 实机检查（P0 版 `electron-check`） | 15 项全部通过，含 Unix 套接字权限 600、强杀后 3 秒重启并续接事件序号、单实例、禁止外部跳转、正常退出清理锁和套接字 |
| worktree | 数据根下建 worktree、超长路径（349 字符）写入、提交和删除都正常。文件系统不区分大小写（`core.ignorecase=true`）：只差大小写的两个分支不能共存、两个文件合并成一个，与 Windows 相同，印证分支名统一用小写 |
| 执行器发现 | Codex 0.158.0 已登录；Claude Code 2.1.185 已登录（OAuth） |
| 电源与空闲 | 见 [P1 实测记录](../p1/findings.md)「息屏、锁屏与空闲事件（macOS）」 |

P1 的桌面端到端（`scripts/p1/e2e-check.mjs`）尚未在 macOS 上跑；P1 的单元与集成测试在 GitHub Actions 的 macOS 上跑（以最新一次 CI 结果为准）。

## 阻塞项与所需条件

- **P0-07**：P0-02 已解除阻塞，子代理与独立会话对比待做。
- **Telegram**：需要测试 bot 与可用代理。
- **P0-06**：桌宠素材来源待定。
