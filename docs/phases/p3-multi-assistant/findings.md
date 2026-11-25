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
