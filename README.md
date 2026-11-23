# 搭档坞 PalDock

本地优先的 AI 桌面助手与多会话协作平台。用户可以通过桌面界面或授权的外部聊天渠道发起任务，由协调助手分派给拥有独立会话的专业助手；执行器可接入本地 Codex、Claude Code 或其他兼容能力。

> 当前阶段：P0 方案与技术验证。仓库只有验证用的样机代码，不代表所列功能已经实现。

本地验证：`pnpm install` 后运行 `pnpm build` 和 `pnpm test`（需 Node 24+）。

## 文档入口

- [产品范围与验收](docs/01-product.md)
- [架构、模块与数据](docs/02-architecture.md)
- [阶段目标与路线图](docs/03-roadmap.md)
- [Codex 与 Claude 协作开发规范](docs/04-ai-collaboration.md)
- [外部项目调研与授权](docs/05-references.md)
- [安全、隐私与测试](docs/06-security-quality.md)
- [启动积压与待决事项](docs/07-backlog.md)
- [桌宠统筹与助手会话设计](docs/08-assistant-orchestration.md)
- [P0 开发计划](docs/plan/p0-technical-validation.md)、[P0 实测记录](docs/p0/findings.md)、[P0 变更说明](docs/pr/p0-technical-validation.md)、[macOS 测试手册](docs/test-kits/macos/README.md)
- 架构决策记录：[ADR 0001 初始架构](docs/adr/0001-initial-architecture.md)、[ADR 0002 进程拓扑、任务板编排与多平台边界](docs/adr/0002-process-topology-and-task-board.md)

## 现阶段约定

首发目标为 Windows 本地体验，架构同时支持 macOS 作为主机、iOS 作为远程客户端（见 ADR 0002）；采用 Electron + TypeScript + SQLite，具体版本通过 P0 技术验证确定。模型可能在云端运行，“本地优先”描述的是应用和用户数据的默认部署位置，不承诺完全离线。

项目目录由用户选择，安装文件优先允许用户选到 D 盘；不得将业务项目默认放到系统目录。仓库默认不收集遥测，后续如需增加须明确说明并征得用户同意。

产品名称与已有同名产品重合，目前仅作为工作名；公开发布前另行检索商标、域名与分发平台名称。暂不开源（2026-11-23 决定），仓库保持私有；只引入允许闭源分发的依赖，不复制 GPL / AGPL 代码或来源不明的素材。
