# 搭档坞 PalDock

本地优先的 AI 桌面助手与多会话协作平台。用户可以通过桌面界面或授权的外部聊天渠道发起任务，由协调助手分派给拥有独立会话的专业助手；执行器可接入本地 Codex、Claude Code 或其他兼容能力。

> 当前阶段：P2 外部渠道已合入（飞书、Telegram 部分项待实机），P3 多助手协作开发完成、待实测与合并。桌面管理窗口 + 本地任务 + Codex / Claude + 外部渠道 + 协调助手带开发、测试、审阅助手按计划协作已能跑通；桌宠尚未实现。进度见 [项目演进总表](docs/roadmap.md)。

本地验证：`pnpm install` 后运行 `pnpm build` 和 `pnpm test`（需 Node 24+）；桌面端到端检查 `node scripts/p1/e2e-check.mjs`（离线模拟执行器）；真实 Codex 验收 `PALDOCK_LIVE_CODEX=1 pnpm exec vitest run tests/live`（消耗少量额度）。

## 文档入口

- [文档目录](docs/README.md)：目录结构与每轮开发写哪些文档
- [项目演进总表](docs/roadmap.md)：一期 / 二期、各阶段与工作项状态
- 各阶段：[P0 技术验证](docs/phases/p0-technical-validation/README.md)、[P1 本地最小产品](docs/phases/p1-local-mvp/README.md)、[P2 外部渠道](docs/phases/p2-external-channels/README.md)、[P3 多助手协作](docs/phases/p3-multi-assistant/README.md)
- 产品与设计：[产品范围与验收](docs/design/01-product.md)、[架构、模块与数据](docs/design/02-architecture.md)、[桌宠统筹与助手会话设计](docs/design/03-assistant-orchestration.md)、[安全、隐私与测试](docs/design/04-security-quality.md)、[Codex 与 Claude 协作开发规范](docs/design/05-ai-collaboration.md)、[外部项目调研与授权](docs/design/06-references.md)
- 架构决策记录：[ADR 0001 初始架构](docs/adr/0001-initial-architecture.md)、[ADR 0002 进程拓扑、任务板编排与多平台边界](docs/adr/0002-process-topology-and-task-board.md)
- 操作指南：[配置飞书自建应用](docs/ops/feishu-app.md)、[申请 Telegram 测试 bot](docs/ops/telegram-bot.md)、[数据、备份与卸载](docs/ops/backup-and-uninstall.md)

## 现阶段约定

首发目标为 Windows 本地体验，架构同时支持 macOS 作为主机、iOS 作为远程客户端（见 ADR 0002）；采用 Electron + TypeScript + SQLite，具体版本通过 P0 技术验证确定。模型可能在云端运行，“本地优先”描述的是应用和用户数据的默认部署位置，不承诺完全离线。

项目目录由用户选择，安装文件优先允许用户选到 D 盘；不得将业务项目默认放到系统目录。仓库默认不收集遥测，后续如需增加须明确说明并征得用户同意。

产品名称与已有同名产品重合，目前仅作为工作名；公开发布前另行检索商标、域名与分发平台名称。以 [Apache-2.0](LICENSE) 开源（2026-11-25 决定，此前 2026-11-23 定为暂不开源）；只引入宽松许可（MIT、BSD、Apache-2.0 等）的依赖，不复制 GPL / AGPL 代码或来源不明的素材。
