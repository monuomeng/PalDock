# P2 外部渠道（飞书、Telegram）：变更说明

分支 `claude/p2-external-channels`，基于 master `ea2ee8f`（P1 已合入）。尚未推送，也未开 PR。计划见 [P2 开发计划](plan.md)（用户 2026-11-24 批准），实测结果见 [P2 实测记录](findings.md)，运维说明见 [配置飞书自建应用](../../ops/feishu-app.md)、[申请 Telegram 测试 bot](../../ops/telegram-bot.md)。

## 前因

P1 让用户能在电脑上建任务、看执行、审批和验收。P2 的目标是人不在电脑前时也能用：在手机上的飞书或 Telegram 里给 PalDock 发任务、看进度、验收；电脑上的审批没人处理时，按项目设定的等级发到手机上处理。

范围按用户 2026-11-24 的决定：只做渠道（监管和沟通模式、本地向量检索挪到 P3 前后）；外部消息只走确定性命令和「消息即任务目标」（每次先发确认卡片），没有主会话和协调助手；先飞书后 Telegram；先单聊，白名单群聊最后做；审批升级等待 3 分钟；Codex 最低版本锁 0.166；任务提醒模式不进 P2。

## 做了什么

| 提交 | 内容 |
|---|---|
| `8bab5ad`、`914e1b1` | P2 计划（获批）、Telegram bot 申请步骤、积压加 P2 项 |
| `bb8d4fa` | P2-01/02/04/05/06 应用层：渠道契约、迁移 003、入站/出站管线、配对与准入、远程命令、通知与审批升级、`ChannelService`；本地服务接入；离线端到端测试 |
| `e485b57` | P2-08 飞书适配器（单聊、群聊 @、交互卡片与回调） |
| `f7898ef` | P2-07 Telegram 适配器（长轮询、内联键盘、HTTP 代理、游标） |
| `70e88dc` | P2-06 桌面锁屏与空闲状态上报 |
| `07300ce` | P2-03 设置页 |
| `115d117` | P2-09 Codex 最低版本；Mac 测试包加钥匙串自检 |
| `4c56cb3` | 飞书机器人信息解析修正；文案统一；飞书应用配置说明 |
| `a812efd` | `/simplify` 自查修改；修复 Codex 首段输出偶发丢失 |
| `e2a3c89` | `/code-review` 自查修复（8 项） |
| `9db135a` | Telegram：409 后至少等 30 秒再试，状态显示重试等待（实机排查：直连靠 AdGuard VPN，超时来自 VPN 不稳） |
| `d2f361f` | 安装版启动任务失败：`codex --version` 在 Electron 里要带 `ELECTRON_RUN_AS_NODE` |
| `32dc2e8` | 安装版执行任务弹命令行窗口：npm 安装的 Codex 直接以隐藏窗口启动原生 `codex.exe` |
| `a9b79d6`、`edd07d0`、`8744fb2`、`401dead` | P2-10 任务续做（计划、实现、`/simplify`、`/code-review`），见 [计划](plan-p2-10-task-continuation.md) |

## 实现方案

**分包与依赖方向**（新增部分）

```text
apps/local-service ──► application（channels/）──► domain ──► contracts
        │ 按需 import()
        ├──► channel-feishu ──► contracts（+ 官方 SDK）
        └──► channel-telegram ──► contracts（+ undici）
apps/desktop ──► domain（空闲阈值）
```

- 适配器只做协议转换：平台事件 → `InboundEnvelope`，`Card` → 平台消息，发送错误 → `ChannelDeliveryError`（`retry` 确定没发出 / `unknown` 可能发出了 / `failed` 平台拒绝）。身份、准入、命令、通知都在应用层的公共管线里，两个平台走同一套。
- 渠道 SDK 在启用时才加载（`AdapterFactory` 是异步的），没启用的渠道不拖慢服务启动。

**数据（迁移 003）**：`principals`（只有「本机所有者」一行）、`channel_accounts`（未绑定 / 已绑定 / 已解绑）、`external_conversations`（单聊归属账号、群白名单、默认项目、等待退回意见的令牌）、`pairing_requests`、`channel_actions`（卡片按钮背后的一次性动作令牌）、`channel_messages`（会话 + 主题 → 平台消息 ID，用于更新卡片）、`channel_settings`、`channel_cursors`；`tasks.origin_conversation_id`；outbox 加主题、最后错误、发送时间；审批加 `escalated_at`。每个查询条件都有逐字一致的部分索引，测试用 `EXPLAIN QUERY PLAN` 固定。

**入站**：适配器回调 → 校验后整体写入 inbox（按平台事件 ID 去重）→ 单个工作器按到达顺序处理（同一会话天然串行，租约过期可回收）→ `InboundProcessor`：登记账号与会话 → 限速（每账号每分钟 10 条）→ 已解绑拒绝 → 未绑定的单聊只回配对码 → 群必须在白名单且 @ 了机器人 → `RemoteCommands`。每一步拒绝都写审计事件（只有平台、会话、原因，不含正文）。

**配对**：陌生账号私聊机器人得到 8 位配对码（1 小时有效，未过期就沿用；全部渠道同时待确认的上限 5 个）；桌面「设置 → 待确认的配对」核对后确认，账号绑定到本机所有者，同账号其余配对作废，并回一条「绑定成功」。

**命令与动作**：`/help` `/projects` `/use` `/tasks` `/status` `/cancel`，其余文字一律当作任务目标，先发确认卡片（只有一个项目时自动用它），点「新建并开始」才建任务。卡片按钮背后是一次性令牌（绑定会话、目标版本、过期时间），用过或目标状态变化后作废。群里只能看状态和建任务，取消、审批、验收只在单聊。

**通知**：从外部建的任务在开始、待验收、阻塞、失败、完成时通知来源会话（单聊带验收 / 退回按钮），桌面建的任务不往外推；解绑账号、移出白名单的群不再收。

**审批升级**：先在桌面；3 分钟无人处理、锁屏或系统空闲（5 分钟）时，发到所有已绑定账号的单聊（只发到正在运行的渠道）。项目的远程审批等级决定手机上能批准什么：L0 只提醒，L1 低中风险，L2 全部；权限扩展任何一端都只能拒绝；拒绝总是允许。两端先到者为准（审批版本号），处理后各端卡片更新为结果，旧按钮作废。规则只在 `domain` 的 `canApproveRemotely` 一处。

**出站**：业务代码与状态变更同一事务写 outbox，事务提交后才唤醒投递；单个工作器按到期时间逐条发送，间隔 300ms；有主题的卡片已发过就更新原卡片（更新失败改发新卡片），同主题还没发出的旧卡片被新卡片取代；`retry` 按指数退避最多 5 次，`unknown` 不重发，`failed` 不重试；渠道停用时待发送的一律失败，不在重新启用时补发；启动时发送中的记为 `unknown`。

**飞书**：官方 SDK WSClient 长连接收 `im.message.receive_v1` 和 `card.action.trigger`；回复全部是 `plain_text` 交互卡片（不解析 Markdown，外部内容不能注入链接或 @），`update_multi` 可更新；卡片回调里没有会话类型，所以按钮值里带上 `k: dm|group`；回调在 3 秒内回 toast，结果另发卡片。用户名查通讯录接口，最多等 1.5 秒，查不到显示 open_id 末 6 位。

**Telegram**：`getUpdates` 长轮询（25 秒），一批全部落库后才推进游标（存本地库，重启不漏不重）；回复是纯文本加内联键盘（`callback_data` 即动作令牌），回调立即 `answerCallbackQuery`；群里认 @机器人、回复机器人、`/命令@机器人`，并去掉这些后缀；配置了代理时所有请求经 HTTP 代理；Token 无效（401/404）停在错误状态，409（有 webhook 或另一个轮询）显示原因并退避重试。

**桌面**：Electron 主进程合并锁屏事件与 `getSystemIdleState`，只在变化时发给服务（服务重启后补发、启动完成前收到的先记下）。设置页（`#/settings`）：两个渠道的启用、凭据（只写不回显）、代理、连接状态与「刚恢复」提示；待确认的配对；已绑定账号的解绑与允许重新配对；群白名单；各项目的远程审批等级（选 L2 要二次确认）。

**凭据**：飞书 App Secret、Telegram Bot Token 只存系统凭据库：Windows 凭据管理器（PowerShell 调 CredRead / CredWrite / CredDelete，秘密经 stdin）、macOS 钥匙串（`security -i` 从 stdin 读命令）。不进仓库、日志、事件、命令行参数和测试快照；设置页只显示飞书 App ID。

**Codex 最低版本**：`discover` 解析 `--version`，低于 0.166.0 报不可用并提示升级；每次 Run 启动前检查（成功结果缓存）。

**任务续做（P2-10）**：实测里第二句话被当成新任务、开了新 worktree，用户要求任务做完一轮后等指令、由人下令结束。
- 「待验收」改叫「待命中」，按钮「继续」（写下一步指令，同一 worktree、同一 Codex 会话再跑一轮）和「结束任务」（提交到分支）。库里仍是 `review` 状态和 `rework` / `accept` 两种决定。
- 单聊记一个当前任务（迁移 004：`external_conversations.current_task_id`，删掉 `awaiting_token`）。普通文字按服务端给出的可用操作（`TaskActions`，与桌面同一套规则）处理：待命中就继续，不弹确认；执行中不建任务；阻塞请到电脑上；用 `/continue` 选中的已结束任务就基于它新建任务；其余当作新任务目标（确认卡片）。任务在任何一端结束时，各单聊的当前任务一并清掉。
- 新命令 `/new`、`/continue`（最近任务列表，点编号看每一轮的指令、说明、改动并设为当前任务；或 `/continue #编号 [指令]`）、`/done`（确认后结束）。编号和分支名都按主键前缀查找。
- 任务进度也发给把它设为当前任务的单聊，所以在手机上继续电脑上建的任务能收到进度。
- 基于已结束的任务继续（单聊或桌面「基于此任务继续」）：新任务（`tasks.continued_from_task_id`）的项目取自来源任务，worktree 从来源分支的提交出发，提示词带来源的目标和最后说明；重新开始时同样带上。

## 验证

- `pnpm build`、`pnpm test`：198 项通过、2 项跳过，连续 5 次全绿（Linux 容器，Node 22）。P2-10 之后 208 项通过、2 项跳过。
- `node scripts/check-licenses.mjs`：55 个包通过。
- 设置页：假数据下在 Chromium 渲染检查。
- `/simplify`（复用、简化、效率、层次四路）与 `/code-review` 已跑，修改见 `a812efd`、`e2a3c89`。

**未验证**：真实飞书租户、真实 Telegram bot、真实 Electron 窗口与 `scripts/p1/e2e-check.mjs`（容器里没有桌面环境）、macOS、GitHub Actions。清单见 [P2 实测记录](findings.md)「待实机」。

## 需要注意的点

1. **外部文本是不可信内容**：只能成为任务目标或退回意见，命令只认白名单，不从文本解析路径、权限或设置；建任务每次要点确认。
2. **飞书断线补投约 5 分钟**（P0 实测），设置页在渠道恢复后 6 分钟内提示「消息可能延迟」；补投与重试靠事件 ID 去重。
3. **群里不审批、不验收**：只能看状态和建任务；审批与验收按钮只发到单聊。
4. **升级只在没有可发的单聊时不标记**：绑定账号或启用渠道后，未处理的审批会照常升级。
5. **渠道停用丢弃待发消息**：停用期间的通知不会在重新启用时补发（避免过时的审批卡片）。
6. **限速在内存里**：重启后清零，不影响安全（未绑定的人只会收到配对码）。
7. **占位默认值**集中在 `packages/domain/src/defaults.ts` 的 `P2_DEFAULTS`。

## 与计划的出入

- 计划里的 `delivery_refs` 表实现为 `channel_messages`（会话 + 主题 → 平台消息 ID），作用相同；卡片节流 500ms 改为出站间隔 300ms（P2 不做流式输出推送）。
- 配对上限从「每账号 3 个」改为「全部渠道同时待确认 5 个」：每个账号本来就只沿用一个未过期的码，按账号计数永远到不了上限；真正要防的是陌生人换账号刷满桌面列表。
- `channel-desktop` / `channel-mock` 包没有建：桌面仍直接调用用例，测试用假适配器走同一条管线。等 P3 主会话进来时再统一。
- 飞书 P0 探测脚本仍在 `packages/channel-feishu/src/probe.ts`，所以这个包还依赖 `platform` 与 `storage-sqlite`；以后挪到 `scripts/`。
- P2-09 里的强杀后真实 Codex 残留、turn 中途崩溃恢复需要消耗额度，本轮没跑；Windows 睡眠唤醒和 macOS 部分待实机。

**P2-10 自查未采纳的建议**：两处 `SUBTASK_LABEL` 合并（同上，渲染进程只能引用类型）；把接续的起点提交记在子任务上（现在执行时按来源分支解析，来源分支被删会明确报错）；`rework` / `accept` 改名为 `continue` / `end`（改动面大，只改界面说法）；「继续」和「选任务」两种按钮合并（回复不同，保留）；`/done` 结束后再查一次子任务（已改为任务结束时由通知统一清掉当前任务）。

**`/simplify` 未采纳的建议**（记录在案）：状态与风险文字移到 contracts 共用（渲染进程只能引用类型，没有打包器）；存储层「带版本更新 + 事件」的公共函数和账号状态机（当前四处写法清楚，改动面超出本轮）；把桌面状态放进 init 消息（启动完成前到达的变化仍需缓存，收益小）；按渠道描述凭据形状、`unsupported` 消息类型、群可用动作表（第三个渠道出现时再做）。

## 推送

本机不能推送。P2 完成后统一推送，请在仓库目录执行：

```bash
git push -u origin claude/project-thread-8azrof
git push -u origin claude/p2-external-channels
```

## 下一步建议

1. 按 [P2 实测记录](findings.md)「待实机」用你的飞书租户和 Telegram bot 走一遍（飞书先按 [配置说明](../../ops/feishu-app.md) 补权限和卡片回调）。
2. 推送后看 GitHub Actions（Windows、macOS）。
3. 把新的 Mac 测试包发出去，收回后补 findings。
