# P0 技术验证：变更说明

分支 `claude/project-thread-ta1qy4`，基于初始设计文档提交 `f23b928`。尚未推送，也未开 PR。计划见 [P0 开发计划](plan.md)，逐项实测结果见 [P0 实测记录](findings.md)。

## 前因

设计稿（[架构](../../design/02-architecture.md)、[ADR 0002](../../adr/0002-process-topology-and-task-board.md)、[路线图](../../roadmap.md)、[积压](../../roadmap.md)）已获批准，按路线图从 P0 开始实现。P0 的目标不是做产品功能，而是用最小的可运行代码确认几项关键假设能否成立：

- Electron 外壳 + 本地服务子进程，经命名管道和一次性令牌通信，能否做到崩溃重启、防止双开、断线不丢事件；
- SQLite 能否同时满足「状态表为准、事件同事务」、乐观并发、入站去重、中文全文检索和「待我处理」派生视图；
- 本机 Codex 的 app-server 协议是否可以稳定接入。

## 做了什么

| 提交 | 内容 |
|---|---|
| `0e2d61b` | pnpm monorepo 骨架；`contracts`（版本化事件、IPC 帧、命令登记表、执行器接口）；`domain`（四个状态机、远程审批等级、升级判定、风险分级草案）；`storage-sqlite`（迁移、WAL、事件同事务、乐观锁、恢复、inbox、「待我处理」、FTS5） |
| `6ae0923` | `platform`（命名管道 / Unix 套接字、帧读写、令牌、PID 锁、进程树结束）；`local-service`（令牌握手、命令分发、事件广播与续拉）；`runtime-codex`（JSON-RPC 客户端与探测脚本）；`desktop`（utilityProcess 看护、受限 preload、管理窗口样机） |
| `be70b56` | `/simplify` 四个维度（复用、简化、效率、层次）自查后的重构 |
| `f510f07` | `/code-review` 自查发现的 10 个问题的修复与回归测试 |

## 实现方案

**分包与依赖方向**：`domain` 只依赖 `contracts`；SQLite 只在 `storage-sqlite`，Electron 只在 `apps/desktop`，Codex 只在 `runtime-codex`，操作系统相关能力在 `platform`。`local-service` 把这些拼起来。

```text
apps/desktop ──► platform ──► contracts
apps/local-service ──► storage-sqlite ──► domain ──► contracts
                   └─► platform
packages/runtime-codex ──► platform
```

**写入规则**：每个写方法一个事务，先校验版本和状态机，再执行带 `version` 条件的 UPDATE，同时追加事件。插入和更新都用 `RETURNING` 直接拿到最新记录，事件也由追加时的返回值构造，调用方不再回查；预编译语句按 SQL 文本缓存。各实体的 UPDATE 是写死的 SQL 常量，差异（重做计数、Run 结束时间、审批渠道）由 TypeScript 根据状态机计算后作为参数传入。

**索引**：每个高频查询都有条件逐字一致的部分索引（待审批、待验收/阻塞子任务、待确认 Run、活动 Run、处理中 inbox、待投递 outbox），测试用 `EXPLAIN QUERY PLAN` 固定下来。

**进程与 IPC**：主进程每次启动服务生成新的管道名和令牌，令牌只经 `postMessage` 下发。客户端连接后第一帧必须是带正确令牌的 hello。重连时服务端先补发断线期间的事件再回 welcome，首次连接从当前最大序号开始，不重放全部历史。服务退出码区分正常、出错和数据根被锁，看护程序据此决定是否重启。

**渲染进程**：`contextIsolation` + `sandbox`，preload 只暴露四个方法；主进程只转发已登记的命令并校验来源页面；禁止导航和新窗口；页面有 CSP。

## 验证

- `pnpm build`（TypeScript 严格模式）通过，`pnpm test` 44 项通过（契约、状态机、存储、平台、服务 IPC、重启策略）。
- `scripts/p0/fork-check.mjs`：启动、双开被拒（退出码 75）、强杀后接管遗留锁、正常退出（退出码 0）均通过。
- `node packages/runtime-codex/dist/probe.js --turn --interrupt --approval --resume`：Codex 0.166.0 的流式、中断、审批请求、跨进程恢复全部通过（经用户同意消耗少量额度）。

- `node packages/runtime-claude/dist/probe.js --turn --interrupt --permission --resume`：Claude Code 2.1.325 的流式、中断、权限请求、跨进程恢复全部通过。

- Electron 实机：窗口、渲染隔离、命令白名单、强杀后 3 秒自动重启并重连、遗留锁接管、单实例、禁止导航、正常退出清理全部通过（见实测记录）。

- macOS（他人协助，macOS 26.4.1 arm64）：构建、45 项测试、服务进程、Electron 15 项实机检查全部通过；worktree 行为与 Windows 一致；Codex 0.138 的 app-server 启动失败，待查。

**未验证**：电源与空闲事件（两个平台）；飞书群聊与卡片。

## 需要注意的点

0. **Codex 中断要等 `turn/started`**：`turn/start` 返回时 turn 可能尚未开始，立刻中断会报错。
0. **服务是否「正常退出」不能看退出码**：Windows 上被结束的 utilityProcess 退出码也是 0，看护程序以「是否主动要求关闭」为准。
0. **Windows 上删除 worktree 要带 `-c core.longpaths=true`**，否则超长路径删不掉且文件残留；分支名统一用小写。
0. **Electron 45 首次运行才下载二进制**，网络不稳时会直接失败；安装流程和 CI 要显式预下载并校验。
0. **启动 Claude Code 子进程必须用白名单环境变量**：否则会继承宿主的 `CLAUDE_*` 变量挂到宿主会话上。Claude 中断后的结果是 `error_during_execution`，要映射为「已中断」。

1. **Windows 上的 Codex 是两层进程**。npm 安装只有 `codex.cmd`，需要用 Node 运行 `codex.js`，而它再启动 `codex.exe`。只结束外层会留下持有管道和目录句柄的内层进程，必须结束整个进程树（目前用 `taskkill /T`，P1 评估 Job Object）。非 npm 全局安装的布局识别不了，需要在设置里填可执行文件路径。
2. **trigram 检索至少 3 个字符**。两字中文词走 LIKE 全表扫描，数据量大时要在 P2 补方案。
3. **SQLite 部分索引按文本匹配**。`status = 'x'` 用不上 `status IN (...)` 的部分索引；新增查询要配逐字一致的索引，并在测试里加 `EXPLAIN QUERY PLAN` 断言。
4. **状态列表有三处必须一致**：`contracts` 的状态数组、迁移里的 `CHECK` 列表、恢复程序的活动状态列表（与部分索引同文本）。已有测试在不一致时失败；迁移发布后不可修改，新增状态需写新迁移。
5. **PID 锁只是第二道防线**。PID 被复用时遗留锁会被误判为存活，此时拒绝启动，需要用户确认后手动删除。
6. **数据根指针**放在 Electron 的 userData（C 盘）下一个很小的 `bootstrap.json`，业务数据全部在用户选择的数据根。
7. **小默认值都是占位**：3 分钟升级等待、风险分级、重启策略参数集中在 `domain/approval-policy.ts` 和 `desktop/restart-policy.ts`，后续直接改常量。
8. 本次在 `.gitignore` 加了 `.idea/`，新增 `.gitattributes` 统一 LF。

## 下一步建议

1. 补测锁屏 / 空闲事件（Windows 本机 + 请 Mac 测试者补做手册第 8 步）；查明 Codex 0.138 启动失败原因并定下最低支持版本。
2. Codex 适配器（P1-03）以 `turn/started` 为准再允许中断，并为 Run 关闭无关的 MCP 服务器以缩短首轮耗时。
3. 做 P0-07（子代理与独立会话对比）；准备飞书测试租户后做 P0-03。
4. P1-01 补 CI（Windows + macOS）和依赖许可证检查。
