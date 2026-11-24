# 申请 Telegram 测试 bot

P2 的 Telegram 单聊（积压 P2-07）需要一个你自己的 bot 和一个能访问 Telegram 的代理。下面的步骤只需要做一次，大约 5 分钟。**bot token 相当于密码，不要发到聊天、文档或仓库里**，只填进 PalDock 的设置页（或按第 3 步存进系统凭据库）。

## 1. 用 BotFather 创建 bot

1. 在手机或电脑的 Telegram 里搜索 **@BotFather**（认准带蓝色认证标的官方账号），点「开始」。
2. 发送 `/newbot`。
3. 按提示输入 bot 的**显示名称**，例如 `PalDock Test`（随时可改）。
4. 再输入 bot 的**用户名**：必须以 `bot` 结尾，全局唯一，例如 `willem_paldock_test_bot`（以后不能改）。
5. 成功后 BotFather 会回复一段话，其中有一行形如 `123456789:AAH...` 的 **token**。复制保存好，第 3 步要用。

## 2. 建议的 bot 设置（都在 BotFather 里发命令）

| 命令 | 选择 | 原因 |
|---|---|---|
| `/setjoingroups` | 选你的 bot → `Disable` | P2 先只做单聊，避免 bot 被别人拉进群。做到白名单群聊（P2-08）时再打开 |
| `/setprivacy` | 保持默认 `Enable` | 进群后只收到 `/命令` 和 @它 的消息，与 PalDock「群里只响应 @机器人」一致 |
| `/setdescription`（可选） | 写一句「PalDock 测试机器人，仅本人使用」 | 陌生人点开时能看到 |

不要给 bot 设置 webhook。PalDock 用长轮询（`getUpdates`），两者只能二选一：设了 webhook 后长轮询会报 409 冲突。

## 3. 把 token 交给 PalDock

**P2-03 完成后**：打开 PalDock →「设置 → 渠道 → Telegram」，粘贴 token，保存。token 写进系统凭据库（Windows 凭据管理器 / macOS 钥匙串），界面不会再显示它。

**在那之前做实机测试**：在 Windows 命令行里执行下面的命令。`/pass` 后面不带值，回车后会提示你输入，这样 token 不会留在命令历史里：

```bat
cmdkey /generic:paldock/telegram /user:bot /pass
```

macOS（以后在 Mac 上测时）：

```bash
security add-generic-password -s paldock/telegram -a bot -w
```

（`-w` 放在最后、不带值，会提示你输入。）

## 4. 代理

在中国大陆，PalDock 需要经代理访问 `api.telegram.org`。PalDock 只需要一个 **HTTP 代理地址**，例如 Clash、v2rayN 等客户端在本机开的 `http://127.0.0.1:7890`（端口以你的客户端设置为准）。

- 在 PalDock「设置 → 渠道 → Telegram → 代理」里填这个地址。
- 先确认代理可用：浏览器开着代理时能打开 `https://api.telegram.org`（显示一段 JSON 或空白页都算通）。
- 只有 Telegram 走这个代理，飞书和 Codex 不受影响。

## 5. 绑定你自己的账号

1. 在 Telegram 里搜索你的 bot 用户名，点「开始」（bot 不能主动给没打过招呼的人发消息）。
2. 随便发一句话，bot 会回复一个 8 位**配对码**。
3. 在 PalDock 桌面「设置 → 渠道 → 待绑定」里核对配对码，点确认。之后这个 Telegram 账号就能用单聊和 PalDock 交互。

其他人给 bot 发消息只会收到配对码，你不在桌面确认就不会绑定，他们的消息都会被拒绝并记入审计。

## token 泄露了怎么办

在 BotFather 里发 `/revoke`，选这个 bot，旧 token 立刻作废并生成新的；然后在 PalDock 设置页（或第 3 步的命令）换成新 token。
