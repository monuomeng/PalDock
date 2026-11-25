# P1 实测记录

记录时间 2026-11-23，Windows 11（10.0.26200，x64），Node 26.7.0（开发与测试），Electron 45.2.3，Codex 0.166.0，git 2.42。只记录实际跑过的结果。计划见 [P1 开发计划](plan.md)，变更说明见 [P1 变更说明](pr.md)。

## 结论一览

| 项 | 结果 |
|---|---|
| 离线测试 | `pnpm test` 143 项通过（契约、状态机、存储、平台、服务 IPC、Codex 适配器对模拟执行器、用例层、P1 端到端流程、许可证判定） |
| 桌面端到端 | `node scripts/p1/e2e-check.mjs` 30 项全部通过（真实 Electron 窗口 + 本地服务 + 离线模拟 Codex + 临时 git 仓库） |
| 真实 Codex（opt-in） | 建任务→执行→回显→证据→验收、执行中取消通过；越界写入被拦截且不写入（发现并修复一处风险误判，见下） |
| 许可证 | 54 个生产依赖（含传递依赖）与随包分发的 electron 均为允许闭源分发的许可证 |
| CI | 工作流已写好（Windows 必过、macOS 同跑），**尚未在 GitHub 上运行**，以第一次运行结果为准 |
| 安装包 | Windows NSIS 安装包已打出，免安装目录实机跑通；安装程序本身未运行（见文末） |

## 真实 Codex（`PALDOCK_LIVE_CODEX=1 pnpm exec vitest run tests/live`）

经用户同意消耗少量额度，共 5 次短对话（计划 2–3 次，多出的 2 次用于定位下面的风险误判）。

| 场景 | 结果 |
|---|---|
| 建任务 → worktree → 执行 → 回显 → 证据 → 验收 | 通过：Codex 在 worktree 内写入 `hello.txt`，无需审批；改动统计含该文件；验收后提交到 `paldock/<编号>` 分支 |
| 执行中取消 | 通过：等 `turn/started` 后中断，Run、子任务、任务均为已取消 |
| 写 worktree 之外的文件 | 文件没有被写入。Codex 的 `workspace-write` 沙箱在 Windows 上直接拒绝了越界写入（「访问被拒绝」）；让它申请提权时，它以**命令审批**（PowerShell 写文件命令，而不是文件改动审批）发来请求，拒绝后正常结束 |

**发现的问题（已修复）**：上面那条越界写文件的 PowerShell 命令，路径里恰好含 `tests` 目录名，被风险分级当成「运行测试」判为**低风险**。修复后命令审批不再按命令名降级；命令里出现 worktree 以外的绝对路径、或用 `..` 跳出，即按「写 worktree 以外」判为高风险。`/code-review` 又发现这个判断会把网址、`cmd /c` 开关、开头的 `powershell.exe` 路径误判为越界，一并修正并加了测试。复跑：唯一一次审批为高风险，拒绝后文件不存在。

**沙箱注意点**：Codex 的 `workspace-write` 沙箱默认允许写系统临时目录（第一次测试把目标文件放在 `%TEMP%` 下时没有触发任何审批）。所以「worktree 以外不可写」只对非临时目录成立；P1 的风险说明与文档按此表述。

## 模拟执行器

`packages/runtime-codex/mock/mock-app-server.mjs` 按行 JSON-RPC 实现 PalDock 用到的 Codex 方法，thread 状态存在 `CODEX_HOME`（或 `MOCK_CODEX_HOME`）下，跨进程可续做与核对。提示词里的指令决定行为：文件审批、命令审批、权限扩展、未识别请求、收回请求、早到的审批、缓慢输出、失败、turn 中途崩溃、完成落盘后崩溃。它与真实 Codex 一致地在 `turn/started` 之前拒绝中断。

## 桌面端到端（`scripts/p1/e2e-check.mjs`）

覆盖：连上服务；渲染进程拿不到 Node；preload 白名单；未登记命令被拒；页面经 `paldock://` 自定义协议加载；表单建任务→执行→流式回显→待验收→证据（改动统计、检查通过、检查输出已脱敏）→验收完成；「待我处理」列出 A 的审批和 B 的待验收；点开只记已读；窗口重载后审批仍在；拒绝 A 只移除 A；退回 B 后旧证据与意见可查；执行中取消；强杀服务后倒计时重启、被中断任务显示阻塞与原因、「恢复」后续做完成；第二实例退出；禁止跳转外部网址；关闭窗口后正常退出并清理锁；重新打开后任务仍在。macOS 上另检查套接字权限为 600。截图写到 `p1-e2e-*.png`（不入库）。

## 其他实测结论

- **file:// 不能加载 ES 模块**：管理界面改为经 `protocol.handle` 注册的 `paldock://app/` 加载，只返回打包目录内的静态文件。
- **`.cmd` 文件按系统代码页读取**：检查命令里 Windows `.cmd` 外壳（如 `pnpm.cmd`）内部的非 ASCII 路径会乱码；参数本身经命令行（UTF-16）传递不受影响。
- **执行器进程与服务进程**：服务被强杀时，Windows 不会连带结束它启动的执行器进程（没有 Job Object）；执行器的 stdin 随之关闭，模拟执行器会自行退出，真实 Codex 是否在 stdin 关闭后退出未单独验证。

## 安装包

`pnpm build` 后在 `apps/desktop` 运行 `pnpm dist`（electron-builder 26.18.0，MIT，仅开发依赖）。本机经 npmmirror 下载打包所需的 NSIS 等工具；`electronDist` 指向已下载的 Electron，避免再下载一次。

| 项 | 结果 |
|---|---|
| 产物 | `release/desktop/PalDock-Setup-0.1.0.exe`（约 117 MB，未签名），NSIS：非一键安装、可选安装目录（可选 D 盘）、按当前用户安装、卸载不删数据 |
| 免安装目录 `win-unpacked` 实机 | 启动后连上本地服务；管理界面从 asar 内经 `paldock://` 加载；用模拟执行器建任务跑到待验收，证明本地服务在 asar 里由 `utilityProcess` 正常启动，执行器经打包后的 `PalDock.exe` + `ELECTRON_RUN_AS_NODE=1` 启动（P0 未实测的一项） |
| 安装程序本身 | **未运行**：安装会写开始菜单和注册表，留给用户在自己的机器上试；卸载行为按 electron-builder 的 NSIS 默认（删除安装目录，不删 `%APPDATA%\PalDock` 与数据目录） |
| 未做 | 代码签名（SmartScreen 会提示未知发布者）、应用图标（用的是 Electron 默认图标）、自动更新 |

## CI 首次运行（2026-11-24）

推送后 GitHub Actions 两个平台都失败：`tests/integration/p1-flow.test.ts` 的用例报「请选择仓库根目录」。原因是 runner 上临时目录路径与 git 返回的路径写法不同——Windows 是 8.3 短名（`C:\Users\RUNNER~1\…`），macOS 的 `/var/folders/…` 是 `/private/var/…` 的符号链接——而本机临时目录没有短名，所以本地没测出来。修复：校验项目目录时先把两边都转成真实路径（`realpathSync.native`）再比较；新增一个 Windows 用例用 8.3 短名 + 大写路径复现（修复前得到与 CI 相同的错误）。同时把 actions 升到 Node 24 版本（checkout@v5、setup-node@v5、pnpm/action-setup@v6），消除 Node 20 弃用警告。macOS 上修复后的结果以下一次 CI 为准。

用户实测安装版：关闭窗口后无残留进程、单实例通过；真实 Codex 任务因测试仓库还没有任何提交而在创建 worktree 时失败。现在建任务时就检查，没有提交的仓库直接提示「请先提交一次再建任务」。

## 安装版复测（2026-11-24，用户本机）

程序装在 `D:\software\PalDock`，数据目录 `D:\software\PalDockCache`。

| 项 | 结果 |
|---|---|
| 关闭窗口后进程 | 无残留（PalDock 与 codex 进程都退出） |
| 单实例 | 运行中再次打开会把已有窗口调到前面 |
| 真实 Codex | 第一次因测试仓库没有任何提交、无法创建 worktree 而失败；提交后复测，在 worktree 中执行成功。这验证了安装版里执行器经 `PalDock.exe` + `ELECTRON_RUN_AS_NODE=1` 启动真实 Codex 的路径 |

**数据目录默认位置**：按用户要求，首次启动时默认建议安装目录旁边的 `PalDockData`，并拒绝安装目录及系统、程序目录（卸载或升级会删除安装目录）。

**端到端检查与已安装的 PalDock 冲突**：本机运行着已安装的 PalDock 时，`e2e-check` 启动的开发版窗口会被单实例锁挡住（立即退出）。新增环境变量 `PALDOCK_USER_DATA`（仅用于开发和测试）给开发版独立的 userData，检查脚本默认使用，不再与已安装版本互相影响。

**CI 第二轮（提交 `b238275`）**：Windows 只剩新加的 8.3 短名用例失败——期望值本身是 runner 的短名临时目录，没有展开成真实路径（测试写错，已改）。macOS 上系统目录拦截把 `/private/var/folders` 下的临时目录也拦了：校验前已把路径转成真实路径，而系统目录列表里有整个 `/private`。现在系统目录判断统一放在 `platform`（项目目录与数据目录共用），只列具体的系统目录（含 `/private/etc`，不再整个拦 `/private`），并加了「用户临时目录不算系统目录」的跨平台用例。

## 锁屏与空闲事件（Windows，2026-11-24，用户本机）

安装版用 `PALDOCK_DIAGNOSTICS=1` 启动，事件写入数据目录下的 `diagnostics.log`（P0-04 留下的未验证项）。没有测睡眠。

| 事件 | 结果 |
|---|---|
| 空闲（60 秒无操作） | 收到：`idle-state` active → idle，时间与阈值吻合（启动后 60 秒） |
| 锁屏 / 解锁 | 收到 `lock-screen`、`unlock-screen`，但**每次各两条**，间隔约 30 毫秒 |
| 锁屏期间的空闲状态 | `getSystemIdleState` 返回 `locked`（idle → locked，解锁后 locked → active） |
| 睡眠 / 唤醒 | 未测 |
| `user-did-become-active` / `user-did-resign-active` | 未收到（这两个是 macOS 事件，Windows 上本来就没有） |

**重复的锁屏事件**：诊断代码里每个事件只注册一次（`startPowerDiagnostics` 只在启动时调用一次），所以重复来自 Electron 在 Windows 上的事件本身。将来审批升级和推送积压要用的是「当前是否锁屏」这个状态，不应按事件次数计数：实现时以状态变化为准（已锁屏时再收到 lock-screen 忽略），或直接用 `getSystemIdleState` 的 `locked`。诊断日志本身照实记录，不做去重。

**CI 第六轮（提交 `4d593db`）**：macOS 上「命令审批：批准后执行」偶发失败。原因是审批请求和 `turn/start` 的响应可能在同一批 I/O 里送达，事件回调先于 `start()` 的返回值执行，测试里用来回复的句柄还是空的，回复丢失。测试改为经 `start()` 的 Promise 回复；`RunSupervisor` 同样防住这个时序：拿到句柄之前要回复的审批先暂存，拿到后补发。

## 息屏、锁屏与空闲事件（macOS，2026-11-24，协助测试者）

macOS 27.0.1（arm64），用 P0 测试包里的 Electron 样机和同一套诊断代码（`PALDOCK_DIAGNOSTICS=1`），由测试脚本让显示器息屏、保持键鼠不动并记录。结果在 `p0-macos-results.zip`。

| 场景 | 结果 |
|---|---|
| 显示器息屏 60 秒后唤醒 | 通过：息屏的同时收到 `lock-screen`（该机设置了息屏即锁定），`getSystemIdleState` 变为 `locked`；唤醒解锁后收到 `unlock-screen`。实测锁定 60.9 秒 |
| 亮屏、键鼠不动 2 分钟后恢复 | 通过：约 74 秒时 `idle-state` active → idle（阈值 60 秒、每 15 秒检查一次），动鼠标后下一次检查变回 active |
| 锁屏 / 解锁事件 | **每次只有一条**，没有 Windows 上的重复 |
| 整机睡眠 / 唤醒 | 未测（手册里是可选步骤） |
| `user-did-become-active` / `user-did-resign-active` | 未收到（息屏、空闲都不触发这两个事件） |

两个平台合起来的结论：锁屏用 `lock-screen` / `unlock-screen` 加 `getSystemIdleState` 的 `locked` 判断都可靠，空闲用 `getSystemIdleState` 轮询可靠（延迟最多一个轮询间隔）；Windows 的锁屏事件会重复，实现时按状态变化处理。macOS 上息屏是否同时锁屏取决于用户的系统设置，审批升级不能只看息屏。两次首次尝试分别因显示器提前唤醒、空闲期间有输入而作废重做，结果以重做为准。
