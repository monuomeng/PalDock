# P3 实测记录

只记录实际跑过的结果。计划见 [P3 开发计划](plan.md)。

## P3-00 前置实验（2026-11-25，Windows 11 x64，Codex 0.166.0，Claude Code 2.1.325）

探测脚本 `node scripts/p3/capability-probe.mjs [--codex] [--codex-round2] [--claude] [--desktop-check]`，配一个最小 MCP 测试服务 `scripts/p3/mcp-stub.mjs`。每个用例在系统临时目录建 `outside/`（代表 worktree 外）、`work/`（worktree）、`work/docs/`（交付范围）、`work/src/`（范围外），让助手分别用文件工具、Shell、MCP 工具往三类路径写文件，再由脚本检查文件是否真的出现。第一轮 Codex 3 轮、Claude 3 轮，第二轮 Codex 4 轮，另有 1 次 Claude 短对话。

### 结论一览

| 项 | 结果 |
|---|---|
| Claude CLI 参数 | 2.1.325 支持 `--input-format`、`--output-format`、`--permission-prompt-tool`、`--resume`、`--mcp-config`、`--strict-mcp-config`、`--setting-sources`、`--disallowedTools`、`--settings`。最低版本先锁 **2.1.325**（只在这一个版本上实测过） |
| 按会话注入 MCP | **Codex**：`thread/start` 带 `config.mcp_servers.<名字>`（command、args、env）即可，服务启动、环境变量（令牌）传到，全局 `~/.codex/config.toml` 不变。**Claude**：`--mcp-config <JSON> --strict-mcp-config`，初始化消息里显示 `connected` |
| Codex 的 MCP 调用审批 | `approvalPolicy: never` 下 MCP 调用**全部失败**；`on-request` 下每次调用发 `mcpServer/elicitation/request`，批准后成功；在服务器配置里加 `default_tools_approval_mode: "approve"` 后，`never` 下也能直接调用。PalDock 的 MCP 桥用最后这种 |
| 只读 | **Codex** `read-only` 沙箱：文件工具和 Shell 写入全部被挡。**Claude** `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell` + 宿主拒绝 MCP 写入：一个文件都没写出去 |
| MCP 工具不受执行器沙箱约束 | Codex `read-only` + 放行 MCP 时，MCP 工具在三类路径都写成功（MCP 服务进程在沙箱外）。所以 MCP 桥给只读角色的工具不能有任何写文件能力，所有写操作只能落到 PalDock 数据库 |
| 限定目录（Claude） | 宿主审批按路径放行文件工具和 MCP、Shell 一律拒绝：**只有交付范围内写成功**。放行 Shell 就无法限定（见下行） |
| Claude 自带沙箱（Windows） | `--settings {"sandbox":{"enabled":true,...}}` 放行 PowerShell 后，三类路径都写成功，Windows 上不起作用 |
| **Codex `workspace-write`（Windows）** | **不限制写入**：文件工具和 Shell 在 worktree 外、范围外、范围内全部写成功；把 cwd 设成交付范围也一样；`config.windows.sandbox = "unelevated"` 和 `features.experimental_windows_sandbox = true` 两种写法都没有改变结果（thread/start 接受了配置，但没有生效，原因未查明） |
| Claude 桌面版能否看到 PalDock 建的会话 | **看不到**（用户在桌面版里查过）。官方文档没有说桌面版会列出或导入命令行会话，且写明其跨会话功能看不到「从终端 CLI 或 VS Code 扩展启动的会话」；也有多份用户反馈同一问题。原生会话仍在 `~/.claude/projects` 里，可在对应目录用 `claude --resume <ID>` 接着聊 |

### 对设计的影响

1. **能力检查（P3-02）**按「执行器 + 平台 + 配置」记录三项：只读可强制、限定目录可强制、Shell 可用。实测值：

   | 执行器 / 平台 | 只读 | 限定目录 | 带 Shell 时限定目录 |
   |---|---|---|---|
   | Codex / Windows | ✅（`read-only` 沙箱） | ❌ | ❌ |
   | Claude / Windows | ✅（禁用写工具 + 宿主审批） | ✅（宿主审批，需禁用 Shell） | ❌ |
   | Codex、Claude / macOS | 未测（Mac 测试包下一版加上） | | |

2. **只读角色**（按用户设置，审阅、调研用 Codex）：Codex `read-only` 实测可强制，成立。
3. **可写角色在 Windows 上没有目录隔离**：需要 Shell 的可写角色（开发、测试）两种执行器都挡不住写到 worktree 外。隔离只剩独立 worktree、验收闸门的交付范围核对和命令审批。2026-11-25 用户决定：接受，派单和设置页明确标「不隔离」，不改用每条命令审批，也不调整测试助手的执行器。
4. **MCP 桥**：Codex 侧服务器配置固定加 `default_tools_approval_mode: "approve"`，审批由桥自己按角色和令牌判定；桥不提供任何写文件的工具。
5. **桌面版可见性**：不作为功能目标；PalDock 任务页显示每次 Run 的原生会话 ID 和恢复方式。

### 遗留

- 第二轮探测写完结果文件后，node 进程又过了几分钟才退出（当时已没有 codex 子进程），收尾时可能有句柄没关。P3-01 / P3-11 检查进程收尾时一并查。
- Codex Windows 沙箱两种配置写法为什么不生效，没有再查；以后 Codex 升级后用同一脚本复测。
- macOS 上的同一组探测还没跑。

## P3-01 Claude 适配器实机验证（2026-11-25，Windows 11 x64，Claude Code 2.1.325）

`node packages/runtime-claude/dist/adapter-probe.js`（`PALDOCK_CLAUDE_PATH` 指向桌面版自带的 2.1.325），4 次短对话，约 0.53 美元（CLI 估算值，订阅登录不按此扣费）。

| 场景 | 结果 |
|---|---|
| 发现 | 版本 2.1.325，已登录，可用。这台机器 PATH 上没有 `claude`，只有桌面版自带的那份，所以要在设置里填路径（P3-02 设置页提供） |
| 普通对话 | 事件顺序 thread → turn → output_delta → completed，约 3.9 秒；用量取 `modelUsage` 合计 |
| 写文件审批 | 收到 1 次 `file_change`（Write hello.txt），拒绝后文件未写出，turn 正常完成 |
| 中断 | 首个输出后发中断，以 interrupted 结束；会话记录里写入中断标记，`checkTurn` 也报 interrupted |
| 恢复 | `--resume` 回到同一个会话 ID，模型记得上一轮 |
| 恢复不存在的会话 | `start()` 拒绝，错误信息带 CLI 的 stderr（No conversation found…），不发事件 |
| turn 身份 | 宿主发出的用户消息带 `uuid`，CLI 原样写进会话记录，所以可以用它当 turn ID 核对 |
| 会话记录结构 | 除 user / assistant 外还有 attachment、queue-operation、api-request 等十余种行，核对时只看 user / assistant；完成的回复 `stop_reason` 为 end_turn，被中断的为 null |

遗留：用量目前只放在 completed / failed 事件里，P3-02 的迁移 005 再落到 Run 上；Codex 侧用量同时补上。

## P3-11 真实执行器端到端实测（2026-11-25，Windows 11 x64，Codex 0.166.0，Claude Code 2.1.325）

`PALDOCK_LIVE_P3=1 npx vitest run tests/live/p3.live.test.ts`。本地服务用构建好的 `apps/local-service/dist/main.js` 跑在子进程里（可以真的强杀），每个场景独立的临时数据根和临时小仓库（`math.js` + `node --test`），不接真实飞书。Codex 按 `D:\software\codex-cli\codex.cmd`，Claude 自动发现（桌面版自带的那份）。执行器分工按出厂设置：协调、开发用 Claude，测试、审阅用 Codex。脚本对 `approval.requested` 一律代为「允许一次」并计数。每个场景成功跑一次。

| 场景 | 结果 | 用时 | 代为批准 |
|---|---|---|---|
| 完整链路：协调助手经 `propose_plan` 提两节点计划（开发 → 测试）→ 确认 → Claude 开发 → Codex 审阅 → 合入集成分支 → Codex 测试 → Codex 审阅 → 合入 → 「待合并」 | ✅ 任务成功，集成分支 `paldock/<任务编号>` 上有 `math.js`、`package.json`、`test/add.test.js`、`test/sub.test.js` 的改动 | 共 162 秒；提计划 10 秒；开发 16 秒、审阅 47 秒、测试 39 秒、审阅 45 秒 | 1（Claude 跑 `node --test`） |
| 强杀重启：开发 Run 拿到 turn 后 `taskkill /F` 杀本地服务，10 秒后重启 | ✅ 杀完当时和 10 秒后都**没有**残留的 codex / claude 进程；重启 2 秒内恢复程序按 `checkTurn`（Claude 会话里这轮没做完）把节点放回队列、按原会话续做；续做 13 秒完成，审阅 40 秒，任务成功 | 共 82 秒；重启到任务成功 56 秒 | 1（续做时 Claude 跑 `node --test`） |
| 冲突：两个并行开发节点改 `math.js` 同一行 | ✅ 两个节点并行开发（各 14 秒）、各自审阅（56 / 60 秒）；先到的合入，后到的合并冲突，交给人，原因写明「合并到集成分支冲突：math.js」，`merge_ops` 记 `conflict` 和冲突文件 | 共 116 秒 | 0 |

用量（Claude 的是 CLI 估算值，订阅登录不按此扣费；Codex 不报费用，只有 token）：

| 场景 | Claude | Codex |
|---|---|---|
| 完整链路 | 协调 0.197 美元、开发 0.165 美元 | 三次 Run 没记到（当时 Codex 用量还没接，见下面第 4 条） |
| 强杀重启 | 协调 0.186、续做 0.138 美元（被杀那次没有用量） | 审阅 6,849 输入 / 579 输出 |
| 冲突 | 协调 0.191、两个开发各 0.169 美元 | 审阅 18,556 / 481、8,442 / 431 |

成功的四次合计 Claude 约 1.4 美元，加上下面修问题前失败的几次约 2 美元。

### 实测发现并已修的问题（都补了离线测试）

1. **父进程被杀后本地服务和 Claude 成了孤儿进程**：第一次跑完整链路时卡住，杀掉测试进程后服务和 claude.exe 还在。本地服务以 `child_process.fork` 启动时，IPC 断开就正常收尾退出（`apps/local-service/src/main.ts`）。修后强杀场景两次检查都没有残留。
2. **Claude 每次改文件都来要审批**：Claude 用 `--permission-mode default`，Edit / Write 都经宿主审批，一个小任务十几次；Codex 的 workspace-write 沙箱改 worktree 内的文件不会来问。按 2026-11-25 的决定（Windows 可写角色「不隔离」、不逐条审批），监管器对**路径全在自己 worktree 里的文件改动**直接批准并写一条 `approval.auto` 审计；worktree 外的写入、命令、权限扩展照旧走审批和风险分级；对话 Run（协调助手）不自动批准。修后三个场景代为批准共 2 次，都是 Claude 运行命令。
3. **设置里填 `codex.cmd` 时 Codex 一律「无法运行 codex --version」**：Node 不经 shell 起不了 `.cmd`。填的是 `.cmd` 时按 npm 布局解析，直接运行包里的原生 `codex.exe`（和 PATH 上找到 `codex.cmd` 时同样处理）。
4. **Codex 用量没有记到 Run 上**（P3-01 遗留里说的「Codex 侧用量同时补上」当时漏了）：适配器接 `thread/tokenUsage/updated`。`total` 是整个 thread 的累计（续做时含以前的 Run），同一份累计也会重复上报，所以按 thread 记基数取差值，子代理的 thread 一并合计；输入口径与 Claude 对齐（缓存命中单列）。
5. **实测脚本自己的竞态**：恢复在服务就绪后异步进行，脚本一重启就读恢复报告，读到空的；改为等恢复处理到这个节点、再等任务真正结束。

### 观察

- 协调助手在任务结束时会被唤醒写汇总，脚本在那之前就关了服务，所以每个场景最后都有一条「应用退出」中断的协调 Run，属预期。
- 审阅（Codex）是链路里最慢的一步，每次 40–60 秒，大部分时间在读代码和重跑测试。
- 被中断的 Run 不写结束时间（`interrupted` 不是终态，可以续做），与 P1 一致。

### 没跑的

- **Windows 睡眠唤醒**（P2-09 遗留）：自动化做不了，放在 [实测清单](checklist.md) 第 3 节由你手测。
- Codex 作为开发执行器时 turn 中途被杀：这轮开发都是 Claude；Codex 的 `checkTurn` 续做 P1 已经实测过。
- 真实飞书 / Telegram：按要求不接，见实测清单第 2 节。
- macOS。

### 后续决定

- 实测时 Claude 跑 `node --test` 每次都来问。2026-11-26 你决定 worktree 内的普通命令也由宿主自动批准（安装依赖、push / merge / rebase / reset、网络下载、涉及 worktree 外、大范围删除仍审批），见 plan.md「已定的几点」第 10 条。

## 对外 MCP 接口试验（2026-11-26，分支 `claude/external-mcp-spike`，Claude Code 2.1.325）

Willem 的要求：「开放一些接口，让 Claude 按规范在 PalDock 中调用，可以测试一下」。结论：**可以实现，整条链路走通了。** 代码只在试验分支 `claude/external-mcp-spike` 的 `37617fa` 上，P3 分支只同步这一节文档；2026-11-26 你决定在 P4 转为正式功能（见 [路线图](../../roadmap.md)）。

### 做了什么（最小实现）

- **外部客户端令牌**（迁移 014 `external_clients`）：在桌面「设置 → 对外接口（试验）」里生成。令牌 `pdx_` 开头，只在生成时显示一次；库里只存 sha256。每个令牌限定开放哪些项目，可以作废，每次调用都重新检查，作废立即生效。
- **`apps/local-service/bridge/external-mcp.mjs`**：stdio MCP 服务器，不依赖任何包。它经本机 IPC 连到正在运行的本地服务，复用 MCP 桥的 `mcp_hello` / `mcp_list` / `mcp_call` 帧，服务端按 `pdx_` 前缀分流到对外工具。
  - Windows 上管道名每次启动都随机，所以本地服务启动时在数据根写一个 `external-endpoint.json`（只有管道名和进程号，不含令牌），退出时删掉。
  - 对外服务每次连接都重新读这个文件，PalDock 重启后下一次调用自动重连。
- **六个工具**（`packages/contracts/src/external.ts`，每个都带说明和参数格式，Claude 接上后自己读得到，不用另外教）：
  - `list_projects`
  - `list_sessions(projectId)`
  - `read_messages(sessionId, limit)`
  - `send_message(sessionId, text, waitSeconds)`：以用户身份写进会话、唤醒协调助手，等这次唤醒处理完，返回回复；等不到返回 `status=processing`（消息已进会话）。
  - `list_tasks(projectId)`
  - `get_task(taskId)`：节点、状态、阶段、集成分支。
  - 没有审批、确认计划、写文件的工具；越过令牌范围的项目、会话、任务一律回「不存在」。
- **审计**：每次认证和调用一条 `ext.<工具>`，actor 为 `external:<客户端 ID>`，结果为 ok / denied / error。
- **实测发现并修的问题**：外部客户端连着时 PalDock 退出会卡住（`server.close()` 要等所有连接断开，而外部客户端不会自己断）。现在退出时断开所有连接，1 秒后强制断开。
- 离线集成测试 `tests/integration/external-mcp.test.ts` 覆盖令牌范围、六个工具、processing、作废、错误令牌、库里没有令牌原文、审计序列。真实实测脚本 `tests/live/external-mcp.live.test.ts`（`PALDOCK_LIVE_EXT=1`）。

### 真实 claude CLI 实测

临时数据根和临时仓库。命令：`claude -p … --mcp-config <临时 json> --strict-mcp-config --allowedTools mcp__paldock_ext`，在临时目录里运行，不改 `~/.claude`，也不改 Claude Desktop 的配置。提示词：列出项目和会话，给第一个会话发一句「你好，请用一句话介绍这个项目」，把回复原样读出来。

| 协调助手 | 结果 | 整次调用用时 | 外部 Claude 费用（估算） |
|---|---|---|---|
| 模拟执行器 | ✅ ToolSearch → list_projects → list_sessions → send_message（直接 replied），读出模拟回复 | 26 秒 | 0.68 美元 |
| 真实 Claude | ✅ 同样的调用顺序，读出协调助手的回复：「这个项目是一个名为"小演示"的演示仓库，目前只有一个 README.md……告诉我目标，我来拆成子任务给你确认。」 | 36 秒 | 0.29 美元 |

- 两次审计都是 `ext.hello:ok → list_projects:ok → list_sessions:ok → send_message:ok:replied`。
- 外部 Claude 先用 ToolSearch 加载工具定义，然后完全按工具说明调用，没有多余的尝试。
- 协调助手按自己的规则回复，提到「拆成子任务给你确认」，计划确认仍在 PalDock。

### 限制

- **`send_message` 的等待时长**：默认等 45 秒，最多 110 秒。真实协调助手回一句话大约 10 秒（P3-11 实测的协调 Run 是 9–12 秒）；这次整次调用 36 秒里大部分是外部 Claude 自己的几轮推理。协调助手要提计划、读代码时可能超过 45 秒，这时返回 processing，外部 Claude 按工具说明稍后用 `read_messages` 再读。
- **Claude Desktop 的工具调用超时**：没有实测。MCP 官方 TypeScript SDK 的请求默认超时是 60 秒，Desktop 很可能沿用，所以默认等待取 45 秒留余量。claude CLI 的超时可以用环境变量 `MCP_TOOL_TIMEOUT` 调大。Desktop 里如果遇到超时，把 `waitSeconds` 调小或者设成 0，再配合 `read_messages`。
- **单向**：只能由外部客户端发起。PalDock 没法主动叫醒 Desktop，计划待确认、审批、任务完成这些事，外部客户端只有被问到时才会去读；主动提醒仍走桌面和飞书。
- **PalDock 要先开着**：Desktop 启动时如果 PalDock 没在运行，`tools/list` 会报「PalDock 没有在运行」，Desktop 可能把这个服务器标成出错，要在 Desktop 里重新连接一次。
- **装好的版本里用不了**：外部客户端用普通 `node` 运行 `external-mcp.mjs`，而安装包把它打在 `app.asar` 里，普通 `node` 读不到。要正式用，打包时得把它放到 `asar` 外（`asarUnpack`），或者让用户用 `PalDock.exe` 加 `ELECTRON_RUN_AS_NODE=1` 运行。现在只能用仓库里的那份。
- 消息在 PalDock 里显示为普通的「你」说的话，没有标「来自外部客户端」；来源只记在审计里（`messages.channel` 的检查约束只认飞书 / Telegram，要标来源得改表）。

### Claude Desktop 里手动添加（示例，我没有替你改）

1. 先在 PalDock「设置 → 对外接口（试验）」生成令牌，勾选要开放的项目。
2. 编辑 `%APPDATA%\Claude\claude_desktop_config.json`（Desktop「设置 → 开发者 → 编辑配置」打开的就是它），在 `mcpServers` 里加一项，然后重启 Desktop：

```json
{
  "mcpServers": {
    "paldock": {
      "command": "node",
      "args": ["D:\PalDock\apps\local-service\bridge\external-mcp.mjs"],
      "env": {
        "PALDOCK_DATA_ROOT": "D:\software\PalDockCache",
        "PALDOCK_EXTERNAL_TOKEN": "pdx_……（在 PalDock 设置里生成的令牌）"
      }
    }
  }
}
```

- 前提是 PalDock 是含这个试验的版本（分支 `claude/external-mcp-spike`），并且正在运行。
- 令牌是明文写在这个配置文件里的，不要把文件发给别人；不用了就在 PalDock 里作废。

## 0.3.6 默认在当前仓库协作：实机验收（2026-11-26，Windows 11 x64，Codex 0.166.0，Claude Code 2.1.325）

`PALDOCK_LIVE_P3=1 npx vitest run tests/live/p3.live.test.ts -t "当前仓库协作端到端|测试正在运行时切分支"`，临时数据根、临时仓库和临时远端（bare 仓库），不碰真实项目和远端。

**场景一：端到端**（功能分支 `feature`，你已暂存 `notes.md`，上游是临时远端）

| 步骤 | 结果 |
|---|---|
| 新登记的项目 | 默认「当前工作区」 |
| 协调助手提「开发 → 测试」计划，确认 | Codex 开发（在项目目录里改 `math.js`，64 秒）→ Claude 审阅 → Claude 测试（新建 `test/mul.test.js`、跑 `node --test`，验证的是开发还没提交的改动）→ Claude 审阅；从确认到全部通过约 117 秒，代为批准 0 次 |
| 做完时 | `math.js` 的改动在原目录里，HEAD 没动，`git diff --cached` 仍只有你的 `notes.md` |
| 「只提交这次修改」 | 协调助手调用 `propose_commit`，卡片两个改动块：`math.js`（Codex 的 fileChange 补丁核对上）、`test/mul.test.js`（Claude 的 Write 内容核对上），都默认勾选；确认后新提交只含这两个文件，`notes.md` 仍是暂存状态 |
| 「推送当前分支」 | 卡片：origin → feature、远端地址、要推的提交；确认后临时远端的 `feature` 等于本地 HEAD |
| 用时 / 用量 | 共 134 秒；Claude 估算约 1.30 美元（协调三轮、审阅两轮、测试一轮），Codex 19,266 输入 / 451 输出 |

**场景二：测试正在运行时切分支**（开发助手在前台跑一个每 1.5 秒写一个文件的慢脚本，写出第 2 个文件后在仓库里 `git checkout -b other`）

| 观察项 | 实测 |
|---|---|
| 检测延迟 | 41 毫秒（fs.watch 触发；轮询兜底是每秒一次） |
| 实际停止的进程 | 5 秒后按临时目录查进程：没有残留（claude.exe 和它启动的 `node slow.js` 都已结束） |
| 切换后已经写入的文件 | 0 个（按文件里记的写入时间比对）；切换前写的 3 个文件列在通知里 |
| 节点状态 | 阻塞，「分支变了，已暂停」；项目暂停写入，主会话里有通知，「项目」页可以选继续或取消 |

**保护边界**（以实测为准）：这次切换在两次写入之间被立即发现，进程在下一次写入前被结束，所以没有残留写入。如果进程正在写、或者写得比检测更快，检测之前写进去的文件无法撤销，PalDock 只能在通知里列出变动的文件；监视依赖文件系统事件，事件丢失时最坏要等一次轮询（约 1 秒）。

## 0.3.7 只提交这次、只推送看过的：实机验收（2026-11-26，Windows 11 x64，Codex 0.166.0，Claude Code 2.1.325）

`PALDOCK_LIVE_P3=1 npx vitest run tests/live/p3.live.test.ts -t "只提交这次、只推送看过的"`，临时数据根、临时仓库和临时远端（bare 仓库），不碰真实项目和远端。场景：`shapes.js` 里两个相隔 30 行的函数；对话 1 里的任务 A 由 Codex 改上面的 `area`，对话 2 里的任务 B 由 Claude 改下面的 `perimeter`，都做完、不提交；然后在对话 2 里说「只提交这次修改」「推送当前分支」，最后在对话 1 里说「只提交这次修改」。跑了 3 次。

| 观察项 | 3 次的结果 |
|---|---|
| B 的提交卡片 | 每次都只列 B 的一块（`perimeter`），默认勾选（Claude 的 Edit 重放核对上）；A 的块不在卡片上 |
| B 的提交 | 每次都只含 `perimeter` 那一行；A 的改动留在工作区（`M shapes.js`） |
| 推送卡片 | 写明实际推送地址（临时远端的路径）、远端 `main` 现在的提交（ls-remote 现查）、要推的提交和总数（1）；确认后临时远端的 `main` 等于卡片上的那个提交 |
| A 的提交卡片（B 提交之后） | 每次都列出 A 的那一块。第 2 次 Codex 报告了 fileChange 补丁，重放核对上，默认勾选；第 1、3 次 Codex 没有 fileChange 记录（用命令改的文件），这一块列出但不勾，标「这次任务期间发生、但核对不上助手的写入」 |
| 用时 / 用量（第 3 次） | 两个任务开发加审阅约 115 秒，全程约 136 秒；Claude 估算约 0.91 美元，Codex 30,151 输入 / 1,219 输出；代为批准 0 次 |

**结论**：「只提交这次」按块筛选，3 次都没有把任务 A 的改动带进 B 的提交；「只推送看过的」推的是卡片上的那个提交。边界：Codex 用 shell 命令改文件时没有写入记录，它的块只能列出、不能默认勾选（宁可少勾），需要你自己勾。

离线验收见 checklist 1d 和下面的测试（都用真实 git，临时仓库和临时裸远端）：

- `tests/integration/p3-git-ops.test.ts`：A、B 改同一文件不同块、提交 B 后 A 的块还在；同一对话指定任务、不能指定别的对话的任务、整个项目要明确要求；整文件写入后你在 Run 期间删另一段（列出不勾）、Run 之后删（不列）；别处加相同的行；写入前你已改过（不勾）；暂存第 10 行只提交第 80 行；重叠时停下；另一份克隆在卡片生成后更新远端（作废）；新建分支被抢先创建（作废）；看完卡片又提交（作废）；独立 pushurl 和多个推送地址；合并锁定两边；暂存区恢复 / 恢复前你又暂存（作废）/ 保留；合并冲突时 `write-tree` 失败照实报错。
- `tests/integration/p3-integration-branch.test.ts`：执行中暂存区被改，结束时暂停、不自动恢复；有合并冲突时不开始这一轮并写明原因。
- `tests/integration/p3-approval-tiers.test.ts`：本轮生成的文件自动放行；敏感路径只能你批、协调助手批不了；权限扩展可以允许一次；非敏感项目外只读交协调助手、不能自批、拿不准和超时回到你；唤醒内容带审批编号和路径；4 个同时到达的审批一组、外部渠道一条消息；L1 只能拒绝并说明、L2 可以远程允许一次。
- 纯单元测试：`packages/domain/src/git-hunks.test.ts`（行号、重放、严格打补丁、块归属、git 写命令）、`packages/domain/src/read-access.test.ts`（敏感路径、分层）、`packages/domain/src/state-machine.test.ts`（远程审批等级）、`packages/runtime-codex/src/codex-adapter.test.ts`（权限扩展允许时授予、拒绝时空权限）。

## 0.3.8 协调助手在发起的对话里找你批：实机验收（2026-11-26，Windows 11 x64，Claude Code 2.1.325）

`PALDOCK_LIVE_P3=1 npx vitest run tests/live/p3.live.test.ts -t "在发起的对话里找你批"`，临时数据根、临时仓库和临时远端，脚本不代批任何审批，全程只用对话（`chat.send` / `chat.get`），不打开「待我处理」。场景：先说「以后助手要读项目外的文件，你都先在这里问我」；让协调助手提一个测试计划，测试助手（真实 Claude）用 Read 读项目外 `assets` 目录里的两张参考图。

| 时间 | 发生了什么 |
|---|---|
| 26 秒 | 确认计划，测试助手开始，第一个读取请求挂起 |
| 46 秒 | 协调助手按你的要求没有自己批（审计 `approval.coordinator`：unsure），在原对话里问你：「『比对截图』的测试助手要读取（只读）项目外的参考图 …\login-before.png。这是你在计划里指定的两张图之一，按你的要求先问你；我建议放行。」消息下面有按钮。测试助手的 Run 一直挂着 |
| 期间 | 第二个读取请求到达：当前问题没变，它排在后面；协调助手说明「一件一件来」 |
| 167 秒 | 你追问「图片在哪？」：它回答了两张图的位置，问题继续挂着（`open`） |
| 179 秒 | 你说「顺便把当前分支推送到 origin」：推送卡片提出（`proposed`），当前问题没变；它说明这句话没有当作对读图的回答 |
| 197 秒 | 你说「第一张可以」：宿主核对后只放行 login-before.png（审计 `approval.conversation`，引用原话「第一张可以」、消息编号 12、渠道桌面）；协调助手回复「login-before.png 已放行，测试助手的『比对截图』继续了。第二张 login-after.png 我刚在上面单独问了你……推送 main 到 origin 的卡片还在等你确认」 |
| 结束时 | 第二张仍待决（新问题只对应第二张，`open`）；推送卡片 `proposed`，临时远端没有变化 |

第一次实机没过的一步：「第一张可以」时协调助手拿不到你那条消息的编号，宿主按规则拒绝了它交的决定（它没有猜，照实让你点按钮）。修法：问题开着时唤醒里写明「用户最新这条消息的编号」，离线测试加了断言；重跑通过。

离线验收：`tests/integration/p3-approval-conversation.test.ts`（模拟执行器，协调助手的工具调用由测试发出，真实文件系统；Git 卡片的执行用计数替身）——原任务挂着时协调助手被唤醒、问你、回答追问、部分放行后看到哪一步继续了；你打字期间来了推送请求，「第一张可以」只对应读图，推送排在后面、不能顺带处理、两件事不能合在一个问题里；「我还没说可以」「为什么要我点允许？」、没有新消息、消息早于问题、原话对不上都拒绝；部分批准后旧按钮失效、第二张的新问题只对应第二张、「都不要」只拒绝列出的项；先回「可以」再点旧按钮推送只执行一次、你可以批协调助手提出的推送卡片、问题里要写明推送目标；协调助手没开口时宿主代问并写回结果；主会话自己发起的请求由宿主直接问；来源缺失不借用别的会话；外部会话只发一张问题卡片、敏感路径不写路径、外部不能批敏感项；投递失败后审批照常外发；桌面问题你不在时只外发一次。纯单元：`packages/domain/src/read-access.test.ts`（一句话算不算同意）。

## 0.3.9 Codex 复审 0.3.8 的修复（2026-11-26）

复审的三个 P1 都在代码里核实属实，另有 macOS CI 暴露的路径问题：

- **决定没绑定触发消息**：每条用户消息各起一次唤醒，交决定只核对「消息在这一轮开始前写入」，唤醒里给的又是最新那条的编号；「可以」之后马上说「等等，不要」，第一轮仍按「可以」执行。修后见 plan.md 第 17 节第 1 条。离线回归：两句连发什么都没放行；执行前刚到新消息不执行；用别的消息编号交决定被拒。
- **提交块越界**：协调助手可以交卡片上默认不勾、你在问题里没看到的块。离线回归：挑卡片外的块、交问题外的块都被拒，只提交问题里的块。
- **git 路径按文本解析**（在临时仓库里实测 git 的输出）：`ls-files -s` 不加 `-z` 时中文路径输出为 `"\344\270\255..."`，以前提交第 4 步对不上，会对你暂存的文件执行 `update-index --force-remove`（变成「已暂存的删除」）；带空格的路径补丁头写成 `+++ b/sp ace.txt<TAB>`，块的路径多一个 TAB，归属核对和保留暂存都对不上。离线回归（真实仓库）：中文加空格的文件名，提交只含助手的块，`git diff --cached` 仍只有你暂存的那一处、没有变成删除，工作区内容不变。
- **macOS 路径**：`/var` 是 `/private/var` 的链接，执行器报告真实路径，以前「在不在工作区里」只做字符串比较，会把工作区里的写入当成工作区外（变成高风险审批，写入证据也丢掉）。修后两边都按真实路径判断；单元测试用目录联接（macOS 上是软链）覆盖。
- **角色会话测试偶发失败**：单独跑 12 次全过，只在全量负载高时失败。原因是测试假设「后结束的会话一定最近用过」，而会话要等收尾后才释放、记使用时间，负载高时顺序会反、或者同一毫秒。实现按使用时间选会话是对的；测试改为从库里读出真正会被续用的那个。改后全量连跑 3 轮都是 480 / 480。
