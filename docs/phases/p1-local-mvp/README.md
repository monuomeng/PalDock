# P1 本地最小产品

| 项 | 内容 |
|---|---|
| 所属 | 一期 |
| 状态 | 完成 |
| 时间 | 2026-11-23 至 2026-11-24（安装版复测与锁屏/空闲事件） |
| 分支 | `claude/project-thread-8azrof`（已合入 master `ea2ee8f`） |
| 负责人 | Claude 实施，Codex 审阅计划，Willem 审批与实机 |

**目标**：桌面 + 本地任务 + Codex。交付可安装的开发预览，含任务和会话列表、审批、日志。

**退出条件**：在选定的临时测试仓库从创建任务到执行及回显跑通；拒绝、取消、崩溃重启、重复启动测试通过；明确备份与卸载。

## 工作项

| ID | 优先 | 状态 | 要点 | 落点 | 备注 |
|---|---|---|---|---|---|
| P1-01 | 高 | ✅ | **工程骨架与 CI**：monorepo、锁定版本、类型检查、离线测试、Windows / macOS CI、许可证检查 | `.github/workflows`、`scripts/check-licenses.mjs`、`vitest.config.ts` | GitHub Actions 2026-11-24 首次运行并修复 |
| P1-02 | 高 | ✅ | **会话 / 任务持久化与迁移**：迁移 002，重启恢复、事务与幂等，含产物的备份 | `packages/storage-sqlite`、`packages/contracts` | 迁移 002、恢复、幂等、备份已测；[备份与卸载](../../ops/backup-and-uninstall.md) |
| P1-03 | 高 | ✅ | **Codex 运行时适配器**：模拟执行器 + 本机 opt-in；审批与错误不丢失，越界命令按高风险分级 | `packages/runtime-codex`、`packages/application`、`tests/live` | 真实 Codex opt-in 已测（消耗少量额度） |
| P1-04 | 高 | ✅ | **桌面管理界面**：「待我处理」、任务列表与详情、审批、拒绝 / 取消、断线提示。验收：A/B 场景（已读不改变进度、重启后仍可定位、退回后旧 Run 证据可查、断线显示「执行状态待确认」） | `apps/desktop/renderer`、`apps/desktop/src`、`scripts/p1/e2e-check.mjs` | Electron 实机端到端 30 项与 A/B 场景通过；安装包 2026-11-24 复测 |

## 文档

- [开发计划](plan.md)
- [实测记录](findings.md)
- [变更说明](pr.md)
- [数据、备份与卸载](../../ops/backup-and-uninstall.md)
