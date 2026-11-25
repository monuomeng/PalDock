# P3 多助手协作

| 项 | 内容 |
|---|---|
| 所属 | 一期 |
| 状态 | 进行中（计划 2026-11-25 已批准） |
| 时间 | 2026-11-25 起 |
| 分支 | `claude/p3-multi-assistant` |
| 负责人 | Claude 实施，Willem 审批 |

**目标**：Codex + Claude 开发、测试、文档分工。交付协调器、依赖图、独立会话、工作区隔离。

**退出条件**：至少两个执行器完成「开发 → 测试 → 汇总」；依赖失败、审批超时、取消、冲突与重启恢复验证；实际可用性以安装和账户权限为准。

## 工作项

| ID | 优先 | 状态 | 要点 | 落点 | 备注 |
|---|---|---|---|---|---|
| P3-00 | 高 | ✅ | **前置实验**：执行器能否按会话注入 MCP 服务器（Codex `thread/start`、Claude `--mcp-config --strict-mcp-config`）；用文件工具、Shell、MCP 实测只读与目录限制，只有通过的执行器配置能承接只读角色；Claude 桌面版能否看到 PalDock 建的会话；锁定 Claude CLI 最低版本 | `packages/runtime-codex`、`packages/runtime-claude` | 2026-11-25 Windows 实测（Codex 0.166.0 / Claude 2.1.325），见 [findings.md](findings.md)：两边都能按会话注入 MCP；只读两边都可强制；Windows 上可写角色无法限定目录，用户确认接受并标「不隔离」 |
| P3-01 | 高 | 📝 | **Claude 运行时适配器**：CLI stream-json 双向流、`--permission-prompt-tool stdio` 走宿主审批、`--resume` 恢复、中断；环境变量白名单；用量记到 Run；离线 mock | `packages/runtime-claude`、`packages/application/src/risk.ts` | 用 CLI 不用 Agent SDK（已定）；最低版本 2.1.325 |
| P3-02 | 高 | 📝 | **角色与执行器设置**：`agent_profiles`（迁移 005），六个出厂角色，执行器按角色 / 项目 / 派单选择；能力检查不满足时拒绝启动；设置页「助手」 | `packages/storage-sqlite`、`packages/domain`、`apps/desktop/renderer/src/views/settings.ts` | 审阅与开发同执行器只提醒，审阅必开新会话 |
| P3-03 | 高 | 📝 | **MCP 桥**：每次 Run 注入 stdio MCP 服务器，身份只认一次性令牌 + Run ID；协调助手与专业助手按角色拿不同工具；服务端逐项校验并审计 | `apps/local-service`、`packages/application`、`packages/contracts` | `propose_plan` 只产生待确认计划 |
| P3-04 | 高 | 📝 | **任务图调度器**：按依赖派单、无环与上限校验；并发全局 10 / 每任务 4 / 同会话串行；失败阻塞下游并唤醒协调助手；取消联动；事件驱动带 `version` | `packages/application`、`packages/storage-sqlite` | 自动重试仅限无外部副作用的失败，最多 1 次 |
| P3-05 | 高 | 📝 | **交付、验收闸门与审阅助手**：`submit_result` 只进 `review`；服务在 worktree 重跑检查命令并核对交付范围，不符即 `failed`；检查与审阅绑定提交 SHA；审阅是子任务内的验收阶段，自动退回最多 2 轮后转人工 | `packages/application/src/check-runner.ts`、`packages/application` | 检查命令随计划一并确认 |
| P3-06 | 高 | 📝 | **任务集成分支与冲突**：每任务一条 `paldock/<任务键>`，先生成候选合并提交并跑集成检查，通过后才推进分支，失败时分支不动；冲突时中止、子任务 `blocked`，由协调助手提解决子任务 | `packages/application/src/git.ts` | 合进你的真实分支仍需你批准，P3 不做 |
| P3-07 | 高 | 📝 | **协调助手主会话**：桌面「对话」页；最小唤醒循环（用户消息、任务事件），软 / 硬上限 20 / 40 次请求；上下文组装与滚动摘要；任务结束后汇总回发起处 | `apps/desktop/renderer`、`packages/application`、`packages/storage-sqlite` | 只有「项目协作」一种模式 |
| P3-08 | 中 | 📝 | **计划确认、任务图界面、自动处理记录单**：计划卡片可改执行器 / 删子任务 / 退回，确认时重新校验并锁定不可变版本，旧 Run 失去提交资格；任务详情按子任务列各次 Run；`auto_decisions` 只读记录页 | `apps/desktop/renderer/src/views`、`packages/storage-sqlite` | 「跳过计划确认」开关默认关 |
| P3-09 | 高 | 📝 | **多子任务重启恢复**：重建就绪队列不重复派单；`wakes` 去重不重复回复；`merge_ops` 对照 Git 与数据库补记、重试或转人工；取消与合并共用任务锁；outbox `unknown` 不重发 | `packages/application`、`packages/storage-sqlite/src/recovery.ts` |  |
| P3-10 | 中 | 📝 | **外部消息交给协调助手**：单聊非命令消息进主会话，计划确认走卡片 / 内联键盘；保留 `/new` 等直达命令；建 `channel-desktop`、`channel-mock` | `packages/application/src/channels`、新包 `channel-desktop` / `channel-mock` | 用户确认留在 P3 |
| P3-11 | 中 | 📝 | **遗留实机验证**：Codex、Claude 强杀残留与 turn 中途崩溃恢复；Windows 睡眠唤醒 | `tests/live`、`findings.md` | 消耗额度，需你同意后再跑；承接 P2-09 |

开发中按实际进度更新状态。顺序与细节见 [开发计划](plan.md)。

## 文档

- 开发计划：[plan.md](plan.md)（2026-11-25 已批准）
- 实测记录：[findings.md](findings.md)
