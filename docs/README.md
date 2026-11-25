# 文档目录

```
docs/
├─ roadmap.md        项目演进总表：一期 / 二期、各阶段状态、待用户决策
├─ phases/           每个阶段一个文件夹
│  └─ pN-xxx/
│     ├─ README.md   阶段信息（状态、时间、分支、负责人）与工作项状态表 PN-xx
│     ├─ plan.md     开发计划（开工前写，获批后实施）
│     ├─ findings.md 实测记录（只记实际跑过的结果）
│     └─ pr.md       变更说明（前因、方案、注意点、与计划的出入）
├─ design/           产品与设计：为什么这样做
├─ adr/              架构决策记录，一事一文，只增不改
├─ ops/              操作指南：配置渠道、备份与卸载
└─ test-kits/        给协助测试者的测试手册
```

## 从哪里看起

- 现在做到哪了：[项目演进总表](roadmap.md)
- 产品与设计：[产品定义与验收](design/01-product.md)、[架构、模块与数据](design/02-architecture.md)、[桌宠统筹与助手会话设计](design/03-assistant-orchestration.md)、[安全、隐私与测试](design/04-security-quality.md)、[Codex 与 Claude 协作开发规范](design/05-ai-collaboration.md)、[外部项目调研与授权](design/06-references.md)
- 架构决策：[ADR 0001 初始架构](adr/0001-initial-architecture.md)、[ADR 0002 进程拓扑、任务板编排与多平台边界](adr/0002-process-topology-and-task-board.md)
- 操作指南：[配置飞书自建应用](ops/feishu-app.md)、[申请 Telegram 测试 bot](ops/telegram-bot.md)、[数据、备份与卸载](ops/backup-and-uninstall.md)
- 测试手册：[macOS 测试手册](test-kits/macos/README.md)

## 每轮开发写哪些文档

1. 开工前在 `phases/pN-xxx/plan.md` 写计划，送审获批后再写代码；同阶段的追加计划命名为 `plan-pN-xx-<主题>.md`。
2. 获批后在该阶段 `README.md` 列出工作项 PN-01、PN-02……，表头固定为 `ID | 优先 | 状态 | 要点 | 落点 | 备注`：要点写做什么和怎样算完成，落点写改动的包或文件，备注写验证证据、日期与遗留。开发中随时更新状态。
3. 实测结果写进 `findings.md`，收尾时写 `pr.md`，并同步 [项目演进总表](roadmap.md) 的阶段状态。
4. 跨模块的设计取舍写 ADR 或更新 `design/`；`ops/` 的路径被代码引用，改名前先改代码。
