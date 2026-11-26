# P3 多助手协作

| 项 | 内容 |
|---|---|
| 所属 | 一期 |
| 状态 | 开发完成（0.3.6，2026-11-26：默认在当前仓库协作的两个实机场景已跑通，见 findings.md），待 Willem 实测与合并 |
| 时间 | 2026-11-25 起 |
| 分支 | `claude/p3-multi-assistant` |
| 负责人 | Claude 实施，Willem 审批 |

**目标**：Codex + Claude 开发、测试、文档分工。交付协调器、依赖图、独立会话、工作区隔离。

**退出条件**：至少两个执行器完成「开发 → 测试 → 汇总」；依赖失败、审批超时、取消、冲突与重启恢复验证；实际可用性以安装和账户权限为准。

## 工作项

| ID | 优先 | 状态 | 要点 | 落点 | 备注 |
|---|---|---|---|---|---|
| P3-00 | 高 | ✅ | **前置实验**：执行器能否按会话注入 MCP 服务器（Codex `thread/start`、Claude `--mcp-config --strict-mcp-config`）；用文件工具、Shell、MCP 实测只读与目录限制，只有通过的执行器配置能承接只读角色；Claude 桌面版能否看到 PalDock 建的会话；锁定 Claude CLI 最低版本 | `packages/runtime-codex`、`packages/runtime-claude` | 2026-11-25 Windows 实测（Codex 0.166.0 / Claude 2.1.325），见 [findings.md](findings.md)：两边都能按会话注入 MCP；只读两边都可强制；Windows 上可写角色无法限定目录，用户确认接受并标「不隔离」 |
| P3-01 | 高 | ✅ | **Claude 运行时适配器**：CLI stream-json 双向流、`--permission-prompt-tool stdio` 走宿主审批、`--resume` 恢复、中断；环境变量白名单；用量记到 Run；离线 mock | `packages/runtime-claude`、`packages/application/src/risk.ts` | 用 CLI 不用 Agent SDK（已定）；最低版本 2.1.325；2026-11-25 离线模拟 15 项测试通过、真实 CLI 5 个场景实测通过，见 findings.md；用量落库随 P3-02 |
| P3-02 | 高 | ✅ | **角色与执行器设置**：`agent_profiles`（迁移 005），六个出厂角色，执行器按角色 / 项目 / 派单选择；能力检查不满足时拒绝启动；设置页「助手」 | `packages/storage-sqlite`、`packages/domain`、`apps/desktop/renderer/src/views/settings.ts` | 2026-11-25 完成（58f42ff）：迁移 005、能力检查、监管器按角色选执行器、设置页「助手」；Windows 可写角色标「不隔离」；macOS 未实测的只读限制只提醒不拒绝；能力检查每次启动 Run 都重新发现执行器 |
| P3-03 | 高 | ✅ | **MCP 桥**：每次 Run 注入 stdio MCP 服务器，身份只认一次性令牌 + Run ID；协调助手与专业助手按角色拿不同工具；服务端逐项校验并审计 | `apps/local-service`、`packages/application`、`packages/contracts` | 2026-11-25 完成（33c9b8f）：令牌只放在服务内存里（存 sha256 哈希，Run 结束即作废，服务重启全部失效），没有建计划里的 `mcp_tokens` 表，理由见迁移 006 的注释；`propose_plan` 随 P3-04 加入，只产生待确认计划 |
| P3-04 | 高 | ✅ | **任务图调度器**：按依赖派单、无环与上限校验；并发全局 10 / 每任务 4 / 同会话串行；失败阻塞下游并唤醒协调助手；取消联动；事件驱动带 `version` | `packages/application`、`packages/storage-sqlite` | 2026-11-25 完成：迁移 007（`plans`、`plan_nodes`）、`propose_plan`、桌面确认 / 退回、调度器、任务状态改由子任务推导，实现要点见 plan.md 第 4 节；节点做完仍由用户逐个「通过」（P3-05 改自动）；**没做**：失败自动重试、唤醒协调助手（P3-07）、按角色的并发上限；协调助手的 Run 在桌面还没有入口（P3-07） |
| P3-05 | 高 | ✅ | **交付、验收闸门与审阅助手**：`submit_result` 只进 `review`；服务在 worktree 重跑检查命令并核对交付范围，不符即 `failed`；检查与审阅绑定提交 SHA；审阅是子任务内的验收阶段，自动退回最多 2 轮后转人工 | `packages/application/src/check-runner.ts`、`packages/application` | 2026-11-25 完成：迁移 008、交付即提交到节点分支并核对范围、节点检查命令随计划确认、审阅助手独立会话 + `submit_review`、桌面人工覆盖，要点见 plan.md 第 5 节；越界或检查失败**交给人**（停在待验收），不进 `failed`；自动退回 2 轮可配置 |
| P3-06 | 高 | ✅ | **任务集成分支与冲突**：每任务一条 `paldock/<任务键>`，先生成候选合并提交并跑集成检查，通过后才推进分支，失败时分支不动；冲突时中止、子任务 `blocked`，由协调助手提解决子任务 | `packages/application/src/git.ts` | 2026-11-25 完成：迁移 009（任务集成分支字段、`merge_ops`）；计划确认时从项目 HEAD 建 `paldock/<任务编号>` 和它的 worktree；节点通过闸门后在临时 worktree 出候选合并提交、跑集成检查，通过才快进集成分支；下游从集成分支建 worktree；冲突或集成检查失败交给人，可「交回开发助手重做」或人工处理后重试；全部通过显示「待合并」，合进你的分支由你自己用 git 做（P3 不做，已确认），要点见 plan.md 第 6 节 |
| P3-07 | 高 | ✅ | **协调助手主会话**：桌面「对话」页；最小唤醒循环（用户消息、任务事件），软 / 硬上限 20 / 40 次请求；上下文组装与滚动摘要；任务结束后汇总回发起处 | `apps/desktop/renderer`、`packages/application`、`packages/storage-sqlite` | 2026-11-25 完成：迁移 011（对话任务、`wakes`、`user_notices`、`session_summaries`，「待我处理」加通知）；桌面「对话」页；唤醒循环（你的消息、节点阻塞 / 交给人、任务全部通过、计划退回、审批被拒），任务事件唤醒 2 分钟间隔、每天 20 次；单次唤醒请求 20 / 40 按 MCP 工具调用计数；`notify_user`（桌面优先，按审批升级规则发单聊，带编号 Q…）；`write_summary` 滚动摘要最小版，要点见 plan.md 第 7 节 |
| P3-08 | 中 | ✅ | **计划确认、任务图界面、自动处理记录单**：计划卡片可改执行器 / 删子任务 / 退回，确认时重新校验并锁定不可变版本，旧 Run 失去提交资格；任务详情按子任务列各次 Run；`auto_decisions` 只读记录页 | `apps/desktop/renderer/src/views`、`packages/storage-sqlite` | 2026-11-25 完成：迁移 012；确认前改执行器、检查命令、删节点，确认和退回都可带意见并交给协调助手；运行中确认新一版（没变的沿用、改了的连同下游重新执行、删掉的取消）；任务详情节点按依赖缩进、可展开各次 Run；~~不做跳过计划确认~~（2026-11-26 改为：对话里确认，简单计划自动确认、可撤回，按项目开关默认开，迁移 014）；按项目、按角色跳过审阅；`auto_decisions` 记跳过审阅、审阅放行 / 退回、唤醒被跳过 / 中断，桌面「自动处理记录」页可按项目筛选；要点见 plan.md 第 8 节 |
| P3-09 | 高 | ✅ | **多子任务重启恢复**：重建就绪队列不重复派单；`wakes` 去重不重复回复；`merge_ops` 对照 Git 与数据库补记、重试或转人工；取消与合并共用任务锁；outbox `unknown` 不重发 | `packages/application`、`packages/storage-sqlite/src/recovery.ts` | 2026-11-25 完成：启动时恢复程序收拾 P3 的中间状态（计划节点的 Run 按 `checkTurn` 补记 / 记失败 / 续做，排队中被打断的重新排队，审阅用新会话重审，`merge_ops` 补记 / 重做 / 交给人并清理合并残留，唤醒放回队列，调度器再推进），每项写 `recovery.performed` 事件，「待我处理」顶部列出本次恢复了什么；P1 / P2 单子任务仍由你手动恢复；要点见 plan.md 第 9 节 |
| P3-10 | 中 | ✅ | **外部消息交给协调助手**：单聊非命令消息进主会话，计划确认走卡片 / 内联键盘；保留 `/new` 等直达命令；建 `channel-desktop`、`channel-mock` | `packages/application/src/channels`、新包 `channel-desktop` / `channel-mock` | 用户确认留在 P3；**外部渠道（飞书 / Telegram）里用户的回复要先交给协调助手判断，不能一律建成新任务**（2026-11-25 实测：用户在飞书回的确认被 P2 建成了任务）；2026-11-25 完成：迁移 013；普通文字进这个外部会话对应的主会话（标明渠道），命令照旧；对 Q 编号问题的回复按引用回复、Q 编号开头、唯一待答问题三种方式交回提问方并标为已答，拿不准时附候选问题交给协调助手；协调助手的回复与外部任务的完成汇总经 outbox 发回；计划确认卡片（L0 不发、L1 只确认不带检查命令的、L2 都能，先到者为准，记录来源渠道）；要点见 plan.md 第 10 节 |
| P3-11 | 中 | ✅ | **遗留实机验证**：Codex、Claude 强杀残留与 turn 中途崩溃恢复；Windows 睡眠唤醒 | `tests/live`、`findings.md` | 2026-11-25 完成：真实 Codex + Claude 跑完整链路（162 秒）、强杀重启（无残留进程，按原会话续做后成功）、冲突（交给人并写明冲突文件），各一次，见 findings.md；实测修了孤儿服务进程、Claude 改文件逐条审批（改为 worktree 内由宿主批准并审计）、`codex.cmd` 路径、Codex 用量四个问题；**睡眠唤醒没跑**，放进 [实测清单](checklist.md) 由你手测 |

开发中按实际进度更新状态。顺序与细节见 [开发计划](plan.md)。

## 文档

- 开发计划：[plan.md](plan.md)（2026-11-25 已批准）
- 实测记录：[findings.md](findings.md)
