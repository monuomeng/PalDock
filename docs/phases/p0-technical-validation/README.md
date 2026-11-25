# P0 方案与技术验证

| 项 | 内容 |
|---|---|
| 所属 | 一期 |
| 状态 | 完成（P0-06 的桌宠素材转到 P4） |
| 时间 | 2026-11-22 至 2026-11-23 |
| 分支 | `claude/project-thread-ta1qy4`（已合入 master `d0d9cd0`） |
| 负责人 | Claude 实施，Willem 审批 |

**目标**：验证 Windows、Codex 会话、审批、存储及飞书可行性。

**退出条件**：确认发现、启动、流式、取消、审批、恢复能力；本机迁移重启实验；飞书长连接权限及去重方案形成记录。不可用能力明确标注。

## 工作项

| ID | 优先 | 状态 | 要点 | 落点 | 备注 |
|---|---|---|---|---|---|
| P0-01 | 高 | ✅ | **Codex app-server 能力矩阵**：本机版本、发现、thread / turn、审批、取消与重启恢复。验收：每项能力有实测记录，无账号时明确标阻塞 | `packages/runtime-codex` | 流式、中断、审批、跨进程恢复已实测 |
| P0-02 | 高 | ✅ | **Claude Code SDK / CLI 评估**：版本、安装与认证、流式、恢复、审批；不以订阅可用性作假设 | `packages/runtime-claude` | CLI stream-json 的流式、中断、权限请求、恢复已实测 |
| P0-03 | 高 | ✅ | **飞书应用与长连接**：测试租户、事件去重、重连、发送和权限记录 | `packages/channel-feishu/src/probe.ts`、`packages/platform/src/credentials.ts` | 单聊长连接、回复、断线补投与去重已实测 |
| P0-04 | 高 | ✅ | **Electron + SQLite + 受限 IPC 样机**（Windows 先行，macOS 验证平台层）：项目选择、正常退出、重启恢复、数据目录与安装位置；utilityProcess 看护、锁屏 / 空闲事件、worktree 长路径与杀毒扫描、macOS 文件夹授权 | `apps/desktop`、`apps/local-service`、`packages/platform`、`packages/storage-sqlite`、`scripts/p0`、`scripts/macos` | Windows、macOS 实机已验证；锁屏 / 空闲 2026-11-24 两平台验证；睡眠唤醒转 P2-09 |
| P0-05 | 高 | ✅ | **版本化事件与领域状态机**：示例与错误场景通过契约测试，跨适配器数据不丢失 | `packages/contracts`、`packages/domain` |  |
| P0-06 | 中 | 🟡 | **许可证与素材决策**：产品许可证、桌宠素材、参考项目许可；不复制受限代码 | `scripts/check-licenses.mjs` | 2026-11-23 定暂不开源；桌宠素材到 P4 再定 |
| P0-07 | 中 | ✅ | **子代理与独立会话对比**（Codex / Claude / ACP）：创建、恢复、控制、子代理事件可见性与费用 | `packages/runtime-codex`、`packages/runtime-claude/src/subagent-probe.ts` | Codex、Claude 已实测；ACP 只做文档评估 |

## 文档

- [开发计划](plan.md)
- [实测记录](findings.md)
- [变更说明](pr.md)
- [macOS 测试手册](../../test-kits/macos/README.md)
