# P0 开发计划：方案与技术验证

状态：主体完成，Electron 实机与 Codex 计费项待补（2026-11-23）。负责人：Claude；分支 `claude/project-thread-ta1qy4`。本文只列本次做什么、按什么顺序、怎样算完成；设计依据见 [架构](../02-architecture.md) 与 [ADR 0002](../adr/0002-process-topology-and-task-board.md)，与旧文档冲突时以这两份为准。完成后的前因后果与注意点写在 [docs/pr/](../pr/)。

## 目标

用最小的可运行代码验证 P0 的关键技术假设，而不是做产品功能。每一项要么给出「能用、怎么用」的证据，要么如实标为阻塞并说明原因。

## 已确认的前提

- Electron；本地服务作为子进程（`utilityProcess.fork`），经命名管道 / Unix 套接字 + 一次性令牌通信，不开 TCP 端口。
- worktree 默认放在数据根；数据库不加密，凭据进系统凭据库。
- 首批外部渠道只有飞书和 Telegram（P2）；P0 只调研、不接真实账号。
- 每个角色的执行器由用户选择；P1 检索用 SQLite FTS5 trigram。
- 审批桌面优先，远程审批按项目 L0 / L1 / L2。
- 小默认值（各角色默认执行器、积压时长、3 分钟升级等待）先用占位，代码里集中定义，后续再调。

## 工作项与顺序

| 顺序 | 积压 ID | 内容 | 完成标准 |
|---|---|---|---|
| 1 | P1-01（提前最小化） | pnpm monorepo、TypeScript 严格模式、vitest；依赖锁定精确版本 | `pnpm build`、`pnpm test` 在本机离线通过 |
| 2 | P0-05 | `packages/contracts`：带 `schemaVersion` 的持久/临时事件、IPC 帧、命令登记表、执行器适配器接口；`packages/domain`：Task / Subtask / Run / Approval 状态机、远程审批等级、升级判定、风险分级草案 | 契约测试覆盖合法、非法、版本不符与往返不丢字段 |
| 3 | P0-04（存储） | `packages/storage-sqlite`：WAL、迁移与迁移前备份、状态更新 + 事件同事务、乐观锁、恢复程序、inbox 墓碑去重与租约、「待我处理」派生视图、FTS5 trigram 检索 | 集成测试用临时库；关键查询用 `EXPLAIN QUERY PLAN` 确认命中索引 |
| 4 | P0-01 | `packages/runtime-codex`：stdio JSON-RPC 客户端；探测脚本记录本机 Codex 版本、initialize、账号状态与协议方法清单 | 生成能力记录；需要消耗额度的真实 turn 只做 opt-in 脚本，经用户同意再跑 |
| 5 | P0-04（进程） | `apps/local-service` + `apps/desktop`：单实例、PID 锁、服务看护（3 秒重启、5 分钟 5 次停止、35 秒退出等待）、命名管道 + 令牌握手、按序号续拉事件、受限 preload | 本机启动、杀服务后自动重启、二次启动被拒的手动验证记录 |
| 6 | P0-02 / 03 / 06 / 07 | Claude Code、飞书、许可证、子代理对比 | 本机未安装 Claude、无飞书测试租户、许可证待用户决定：记录为阻塞及所需条件 |
| 7 | — | `/simplify`、`/code-review` 自查；更新 07 积压状态；写 `docs/pr/` | 自查问题已修复或记录 |

## 代码质量约定（用户要求）

- 合理分包：领域层不依赖 Electron、SQLite 或供应商 SDK；平台相关能力在 `packages/platform`。
- 方法短小、命名直白；SQL 写成常量，结构清晰，部分索引条件与查询条件一致以复用索引。
- 写入后需要结果时用 `RETURNING` 直接拿回，不再二次查询；预编译语句按 SQL 缓存复用。
- 每阶段结束跑 `/simplify` 和 `/code-review`。

## 不在本次范围

真实飞书 / Telegram 接入、Claude 适配器、MCP 桥、任务调度器、桌宠、安装包与签名。推送分支或开 PR 前先问用户。
