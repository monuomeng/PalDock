# P2 外部渠道（飞书、Telegram）

| 项 | 内容 |
|---|---|
| 所属 | 一期 |
| 状态 | 已合入；3 项待实机，1 项部分完成 |
| 时间 | 2026-11-24 至 2026-11-25 |
| 分支 | `claude/p2-external-channels`（已合入 master `fc49e0c`） |
| 负责人 | Claude 实施，Willem 审批与实机 |

**目标**：飞书、Telegram 单聊与授权群聊。交付渠道适配器、身份映射、消息回传。

**退出条件**：测试租户完成消息接收、身份/群白名单、会话路由、去重、断线重连、审批关联；拒绝未授权来源。

## 工作项

| ID | 优先 | 状态 | 要点 | 落点 | 备注 |
|---|---|---|---|---|---|
| P2-01 | 高 | ✅ | **渠道契约与公共管线**（迁移 003）：inbox 去重 / 串行 / 租约，outbox 限速重试、unknown 不重发；桌面与模拟渠道走同一契约 | `packages/contracts/src/channels.ts`、`packages/application/src/channels`、`packages/storage-sqlite` | 离线验证 |
| P2-02 | 高 | ✅ | **身份绑定与配对码**：未绑定只回配对码，桌面确认后绑定，解绑后拒绝，均有审计 | `packages/application/src/channels/inbound-processor.ts`、`packages/storage-sqlite/src/channel-repository.ts` | 离线验证；待确认配对全部渠道合计上限 5 个 |
| P2-03 | 高 | ✅ | **凭据与渠道设置页**：凭据只写不回显（Windows 凭据库 / macOS 钥匙串），渠道启停互不影响 | `packages/platform/src/credentials.ts`、`apps/desktop/renderer/src/views/settings.ts` | macOS 钥匙串 2026-11-25 测试包已验证 |
| P2-04 | 高 | 🧪 | **飞书单聊适配器**：卡片、卡片回调（长连接）、卡片更新、断线补投提示 | `packages/channel-feishu` | 代码完成，等测试租户实测；[配置飞书自建应用](../../ops/feishu-app.md) |
| P2-05 | 高 | ✅ | **外部命令与任务链路**：命令、消息建任务（确认卡片）、结果回发起会话 | `packages/application/src/channels/remote-commands.ts`、`packages/application/src/channels/cards.ts` | 离线验证 |
| P2-06 | 高 | ✅ | **桌面状态与审批升级**：桌面 3 分钟无人处理 / 锁屏 / 空闲时升级到外部渠道，L0 / L1 / L2，先到者为准 | `packages/application/src/channels/notifier.ts`、`apps/desktop/src` | 离线验证；手机批准后桌面弹窗关闭待实机 |
| P2-07 | 高 | 🧪 | **Telegram 单聊适配器**：长轮询、HTTP 代理、内联键盘、409 后退避 | `packages/channel-telegram` | 代码完成；2026-11-24 实机遇 429，需在你的代理下复测；[申请 bot](../../ops/telegram-bot.md) |
| P2-08 | 低 | 🧪 | **白名单群聊**：只响应 @机器人，群内不审批 | `packages/application/src/channels/inbound-processor.ts` | 代码完成；可移出 P2 |
| P2-09 | 中 | 🟡 | **P0 / P1 遗留验证**：Codex 最低版本、睡眠唤醒、强杀后执行器残留、turn 中途崩溃恢复 | `packages/runtime-codex`、`scripts/p2` | 最低版本已锁 0.166；残留与崩溃恢复（消耗额度）、Windows 睡眠唤醒未跑 |
| P2-10 | 高 | ✅ | **任务续做**：产出后进「待命中」而非「待验收」；单聊有当前任务，`/new` `/continue` `/done`；可基于已结束的任务继续 | `packages/application/src/channels`、`packages/storage-sqlite/src/migrations/004-task-continuation.ts`、`apps/desktop/renderer` | 2026-11-24 你实测通过；[计划](plan-p2-10-task-continuation.md) |

未完成项的具体检查步骤见 [实测记录](findings.md)「待实机」。

## 文档

- [开发计划](plan.md)、[P2-10 任务续做计划](plan-p2-10-task-continuation.md)
- [实测记录](findings.md)
- [变更说明](pr.md)
- [配置飞书自建应用](../../ops/feishu-app.md)、[申请 Telegram 测试 bot](../../ops/telegram-bot.md)
