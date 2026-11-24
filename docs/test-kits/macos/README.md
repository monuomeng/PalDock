# PalDock P0 macOS 测试手册

本文写给协助测试的人，以及他们使用的 AI 编码助手（Claude Code、Codex 等）。AI 助手可以按本文从头到尾执行；遇到标注「需要人操作」的步骤时停下来请人完成。

## 背景

PalDock 是一个本地优先的 AI 桌面助手，主机支持 Windows 和 macOS。P0 阶段的技术验证已在 Windows 上完成，这次要在 Mac 上确认同一套代码能正常工作，重点是 macOS 特有的部分：Unix 域套接字、Electron 子进程看护、电源与锁屏事件、文件系统大小写。

这是私有项目的内部测试包，**不要转发、不要上传到公开位置**。

## 安全边界（AI 助手必须遵守）

- 只在本测试包解压出来的目录里操作；所有数据写在系统临时目录，不读写测试者的其他项目或个人文件。
- 不需要、也不要输入任何账号、密码、API Key 或令牌。不要登录 Codex、Claude、飞书等服务；第 7 步只读取本机是否安装及登录状态，不会发起对话。
- 不要 `git push`，不要修改全局 git 配置，不要安装除下面前置条件以外的软件。
- 某一步失败时，记录输出并继续下一步，不要尝试修改 PalDock 源码让它通过。

## 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| macOS | 13 或更高（Apple Silicon 或 Intel 均可） | `sw_vers` |
| Node.js | 24 或更高 | `node -v` |
| pnpm | 10.x（Node 自带的 corepack 可提供） | `corepack enable && pnpm -v` |
| git | 任意近期版本（Xcode 命令行工具自带） | `git --version` |
| 网络 | 能访问 npm 和 Electron 下载源；中国大陆网络建议先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` | — |

磁盘空间约 1 GB（依赖和 Electron 二进制）。

## 执行步骤

1. 解压测试包，进入目录：

   ```bash
   unzip paldock-macos-test-kit.zip && cd paldock
   ```

2. 运行一键检查（约 5–15 分钟，主要是安装依赖和下载 Electron）：

   ```bash
   bash scripts/macos/run-p0-checks.sh
   ```

   AI 助手独立运行时可加 `--skip-manual`，跳过第 8 步；之后请人单独补做第 8 步（见下文）。

3. 第 5 步会弹出一个「PalDock（P0 样机）」窗口，脚本会自动操作并在几十秒后关闭它，期间不要点击窗口。若 macOS 弹出「是否允许 Electron 接受传入网络连接」之类的提示，选「拒绝」即可（调试端口只在本机使用，不影响测试）。

4. **第 8 步（需要人操作）**：脚本会再打开一次 PalDock 窗口并暂停，按终端提示依次：
   - 按 `Control + Command + Q` 锁屏，等 30 秒后解锁；
   - 不碰鼠标和键盘 90 秒；
   - 可选：让 Mac 睡眠约 1 分钟后唤醒；
   - 回到终端按回车。

5. 结束后仓库根目录会生成 `p0-macos-results.zip`，把这个文件发回给 PalDock 开发者即可。里面只有检查结果和日志，不含个人数据。

## 每一步在验证什么、预期结果

| 步骤 | 验证内容 | 预期 |
|---|---|---|
| 2 安装 | 锁定版本的依赖能在 macOS 安装；Electron 45.2.3 能下载 | `exit=0` |
| 3 构建与测试 | TypeScript 严格模式构建；全部单元/集成测试（含 SQLite FTS5 中文检索、Unix 套接字通信） | 构建 `exit=0`，测试全部通过 |
| 4 服务进程 | 本地服务经 Unix 套接字握手；同一数据目录第二个服务被拒（退出码 75）；强杀后遗留锁被接管；正常退出码 0 | 日志中依次出现 `ready`、`locked`、`ready`、`graceful exit 0` |
| 5 Electron | 窗口连上服务；渲染进程拿不到 Node；命令白名单；**套接字文件权限为 600**；建任务→执行→回显→验收、审批、取消；服务被结束后 3 秒自动重启并可恢复任务；单实例；禁止跳转外部网址；关闭窗口后锁文件和套接字被清理（P1 起改用 `scripts/p1/e2e-check.mjs`） | `p1-e2e-check.json` 中 `failed: 0` |
| 6 worktree | 默认不区分大小写的 APFS 上，只差大小写的分支名和文件名会冲突；深层路径可用 | 记录事实即可，`INFO` 不算失败 |
| 7 执行器发现 | 能否在 PATH 上找到 Codex / Claude Code 及登录状态（不发起对话） | 未安装时报告 `available: false` 属正常 |
| 7b 钥匙串 | P2 渠道凭据（飞书 App Secret、Telegram Bot Token）存在登录钥匙串：用随机假秘密写入、读回、覆盖、删除 | `p2-credential-check.json` 中 `failed: 0`；若弹出钥匙串授权框，选「允许」并记下 |
| 8 电源事件 | Electron `powerMonitor` 在 macOS 上实际发出的事件 | `power-diagnostics.log` 中应出现 `lock-screen`、`unlock-screen`、`idle-state`（active → idle → active），睡眠时有 `suspend` / `resume` |

## 结果包内容

`p0-macos-results/` 目录（已打包为 `p0-macos-results.zip`）：

- `environment.txt`：系统、Node、pnpm、git 版本与文件系统类型
- `run.log`：每一步的命令、输出和退出码
- `p1-e2e-check.json`、`p0-worktree-check.json`：逐项结果
- `codex-discovery.json`、`claude-discovery.json`：执行器发现结果（只有版本和是否登录）
- `p2-credential-check.json`：钥匙串读写结果（不含秘密）
- `power-diagnostics.log`、`power-app.log`：第 8 步的事件记录（P2 的审批升级依赖其中的锁屏与空闲状态）

## 常见问题

- **`pnpm install` 卡在 Electron 下载**：设置上面的 `ELECTRON_MIRROR` 后重试；或删除 `node_modules` 后重新运行脚本。
- **第 5 步窗口没出现或连接超时**：查看 `p1-e2e-check.json` 末尾的 `appOutputTail`，原样发回即可。
- **只想单独补做第 8 步**：先完成第 2、3 步，然后运行 `bash scripts/macos/run-p0-checks.sh`，等前面步骤跑完后按提示操作；或者手动执行脚本第 8 步中的命令。
