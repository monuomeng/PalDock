# 开源项目调研与借鉴边界

调查日期 2026-11-17；下表为官方仓库与公开文档提供的信息，不代表已安装、审计或测试。引用前重新核对具体版本、许可证、依赖及资源权利；“参考”不等于可以无条件复制代码。

| 项目 | 相关能力 | 可参考之处 | 许可 / 注意 |
|---|---|---|---|
| [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) | 桌宠、语音、记忆、电脑操作 | 桌宠交互、窗口、托盘、权限体验，Core / Persona / World 分层 | 当前 AGPL-3.0-or-later，附特定额外许可；角色素材另有权利，勿直接复制 |
| [AionUi](https://github.com/LeonSooLab/aionui) | 本地桌面多 Agent 客户端、CLI 兼容和协作 | 运行时适配、桌面管理、会话与外部渠道 | 仓库 Apache-2.0；核对具体依赖和第三方资源 |
| [Happier](https://github.com/happier-dev/happier) | 多终端和多执行器会话 | 会话恢复、事件流、远程客户端与权限交互 | 核对当前各子项目的许可、运行依赖和部署边界 |
| [OpenClaw](https://github.com/openclaw/openclaw) | 个人助手、多消息渠道、工具与插件 | 渠道适配、消息生命周期、插件隔离与运维经验 | 核心仓库 MIT；各扩展和外部平台规则需单独核对 |
| [Orkas](https://github.com/Orkas-AI/Orkas) | 本地桌面多助手、任务和 CLI 集成 | 协调者与专业助手的任务分配、产品体验 | 仓库声明 MIT；相关依赖与素材单独核对 |

## 平台协议的一手资料

- [Codex app-server](https://developers.openai.com/blog/codex-as-a-platform)：官方描述 thread、turn、事件、审批等能力。实现前锁定本机版本并核验协议及认证方式。
- [Claude Code CLI 参考](https://docs.anthropic.com/en/docs/claude-code/cli-usage)：非交互调用、结构化输出、按 ID 恢复；以当前版本和其官方 Agent SDK 文档为准。
- [飞书事件订阅](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/event-subscriptions)：长连接与服务端事件两种入口，仍须完成平台应用、权限、发布及消息收发配置。
- [Coopanion 隐私与数据](https://coo.palailab.org/guide/privacy/)：作为提示用户数据去向的体验参考，不视为 PalDock 的数据策略。

## 引入依赖的检查

记录来源、版本/commit、许可证、维护状态、传递依赖、支持平台、联网及数据处理、原生二进制来源、漏洞检查、升级和移除成本。明确是否仅借鉴设计、作为独立依赖，或复制代码；复制前核对版权、NOTICE 和协议义务。未确定 PalDock 自身许可证，先不复制受限制的实现或美术素材。

## 与现有项目的关系

PalDock 与这些项目有明显功能重叠。差异化假设为：中文优先、可选桌宠、授权的外部渠道、多个独立会话和混合执行器。其价值必须通过 P0/P1 用户验证，当前没有证据证明它比已有方案更好。
