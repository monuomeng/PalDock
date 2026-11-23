# P1 本地最小产品：变更说明

分支 `claude/project-thread-8azrof`，基于 master `d0d9cd0`（P0）。尚未推送，也未开 PR。计划见 [P1 开发计划](../plan/p1-local-mvp.md)（第四版，经 Codex 两轮审阅、用户批准），实测结果见 [P1 实测记录](../p1/findings.md)，运维说明见 [数据、备份与卸载](../ops/backup-and-uninstall.md)。

## 前因

P0 证明了 Electron 外壳 + 本地服务、SQLite 存储和 Codex app-server 都能用。P1 的目标是把它们连成一条用户能走通的链路：在桌面上选一个本地 git 仓库、写下目标，PalDock 在独立 worktree 里让 Codex 执行，界面流式回显、弹出审批、收集证据，由用户验收或退回。路线图的退出条件是：在临时测试仓库里从建任务到执行再到回显跑通；拒绝、取消、崩溃重启、重复启动都有测试；备份和卸载有说明。

P1 有意简化为「一个任务一个开发子任务」、执行器只有 Codex、审批只在桌面、验收由用户点按钮、生命周期只做「随界面退出」。表结构仍按 Task / Subtask / Session / Run 四层设计，以后加协调助手和多执行器不用改表。

## 做了什么

| 提交 | 内容 |
|---|---|
| `f1fa5aa` … `78ea040` | P1 计划四个版本（Codex 两轮审阅、用户三处决定） |
| `3646072` | P1-01：GitHub Actions（Windows 必过、macOS 同跑）、许可证检查（SPDX 表达式 + 传递依赖）、vitest 别名自动生成、`*.live.test.ts` 默认跳过 |
| `c1be357` | 契约（记录类型、命令、执行器适配器、存储端口）、迁移 002、存储仓储、Codex 适配器与离线模拟执行器 |
| `53692ab` | `packages/application` 用例层（监管 Run、审批、worktree、证据、受控检查命令）、本地服务接入、离线集成测试 |
| `32664a9` | P1-04 管理界面与桌面端到端检查脚本；备份与卸载说明 |
| `92c799f` | 真实 Codex opt-in 验收；修复越界命令被判为低风险 |
| `6a8e6a8` | `/simplify` 自查修改 |
| `d5c3459` | `/code-review` 自查修复（10 项） |

两个 `wip(p1)` 提交是开发中途的存档，内容完整、能编译，但单独看时测试未全部改完；如需整理历史，可在合并前把它们与后一个提交合并。

## 实现方案

**分包与依赖方向**

```text
apps/desktop ──► platform ──► contracts
     └─ renderer（浏览器 ES 模块，只用 contracts 的类型）
apps/local-service ──► application ──► domain ──► contracts
         │                  └──────► platform
         ├──► storage-sqlite ──► domain
         └──► runtime-codex ──► platform
```

- `contracts`：记录类型、命令登记表与返回类型（`CommandResults`）、执行器适配器契约（`RuntimeAdapter` / `RuntimeRun` / `TurnCheck`）、存储端口（`StorePort`）。
- `domain`：状态机、风险分级、P1 占位默认值（`P1_DEFAULTS`，集中在一处）。
- `application`：只依赖端口。`TaskService` 是命令对应的用例；`RunSupervisor` 监管执行中的 Run；`check-runner`、`git`、`risk`、`redact`、`prompts` 各管一件事。
- `storage-sqlite`：SQL 只在这里；`TaskRepository` / `RunRepository` 实现端口。
- `runtime-codex`：Codex 协议只在这里；`event-mapping.ts` 是协议到契约的纯函数映射。
- `platform`：进程树、白名单环境变量、路径包含判断、可执行文件查找。

**数据（迁移 002）**：任务加目标、结构化检查命令（`{ executable, args[] }`）和确认时间、幂等键；子任务加状态原因和 worktree（路径、分支、起点提交）；新表 `sessions`、`runtime_sessions`、`run_results`、`run_reviews`；Run 加会话、`native_turn_id`（只写一次）、`resumes_run_id`、失败原因；审批加类别、执行器请求 ID、目录、细节；消息加 `run_id`；重建「待我处理」视图。每个查询条件都有逐字一致的部分索引，测试用 `EXPLAIN QUERY PLAN` 固定；写入一律 `RETURNING`，建任务直接返回写入得到的记录。

**一次 Run 的生命周期**（`RunSupervisor`）

1. 子任务 queued → running，创建 Run；worktree 首次建在数据根 `worktrees/<12 位编号>`，分支 `paldock/<编号>`（小写，`-c core.longpaths=true`，可重入）。
2. Codex 适配器每次 Run 起一个 app-server（白名单环境变量；在 Electron 里带 `ELECTRON_RUN_AS_NODE=1`），`thread/start`（`workspace-write` + `on-request`）或 `thread/resume`，`turn/start` 的响应里就记下 turn ID。
3. 流式输出走临时事件，每 5 秒合并成一条持久消息。
4. 审批：命令、文件改动、权限扩展三类映射为审批，风险按请求的客观内容判定；权限扩展只能拒绝；未识别的请求立即回错误；过期（30 分钟）即拒绝；执行器收回的请求置为已取消。
5. turn 完成：Run 成功；暂存改动得到改动统计；检查命令（已确认的）在 worktree 里受控运行，输出脱敏后存为 `artifacts/checks/<runId>.log`；子任务进入**待验收**（模型说完成不会直接成功）。
6. 断线：Run 进入「执行状态待确认」，挂起审批取消，只按这次 Run 的 turn 核对，有明确终态才更新，3 次仍无法确认则中断并交给用户。
7. 取消：turn 开始前取消先等 `turn/started`（最多 10 秒）再中断，否则结束进程树。

**用户操作**（`TaskService`，都带客户端看到的版本号）：建任务（幂等键）、取消、审批、验收（提交证据里那份暂存改动到任务分支，不合并）、退回（新 Run 沿用 thread，带意见）、阻塞时的恢复（新 Run 续做同一 thread 并指回原 Run）/ 重新开始（新 thread）/ 放弃。哪些操作可用由服务端算出（`TaskDetail.actions`），界面只按它显示按钮。

**启动恢复**：未结束的 Run → 已中断；挂起审批 → 已取消；排队中或执行中的子任务和任务 → 阻塞（排队只在内存里）。用户在「待我处理」里选择怎么继续。

**管理界面**：不引入框架，TypeScript 编译成浏览器 ES 模块，经 `paldock://app/` 加载（严格 CSP、沙箱、受限 preload）。首页「待我处理」，另有任务列表、任务详情（流式输出、审批卡片、证据、验收与恢复操作）、新建任务（项目目录由主进程系统对话框选择；检查命令分两栏填写并需确认）、「备份数据」按钮。只在事件涉及当前页面时重绘，并保留正在输入的内容。

## 验证

- `pnpm build`、`pnpm test`：143 项通过。
- `node scripts/p1/e2e-check.mjs`：30 项全部通过（Windows）。
- `PALDOCK_LIVE_CODEX=1 pnpm exec vitest run tests/live`：真实 Codex 0.166.0，3 个场景通过（经用户同意消耗少量额度）。
- `node scripts/check-licenses.mjs`：通过。
- `/simplify`（复用、简化、效率、层次四路）与 `/code-review` 已跑，修改见上面两个提交。

- 安装包：打出 `PalDock-Setup-0.1.0.exe`，免安装目录实机启动并用模拟执行器跑到待验收。

**未验证**：GitHub Actions 尚未运行（工作流需推送后才会跑）；macOS（测试包里的 Electron 检查已改为 P1 脚本，待下一轮 Mac 测试）；安装程序本身没有在本机运行（会写开始菜单和注册表）。

## 安装包

用 electron-builder 26.18.0（MIT，仅开发依赖）打 Windows NSIS 安装包，可选安装目录、按用户安装、卸载不删数据：`pnpm build` 后在 `apps/desktop` 运行 `pnpm dist`，产物在 `release/desktop/`。结果见 [P1 实测记录](../p1/findings.md)「安装包」。

## 需要注意的点

1. **检查命令以用户账户权限运行**，可以联网、不经执行器沙箱，所以建任务时必须确认；改为结构化参数、环境变量白名单、超时与进程树清理、输出脱敏。Windows `.cmd` 外壳内部的非 ASCII 路径会乱码（系统代码页），参数不受影响。
2. **验收只提交收集证据时暂存的改动**：检查命令之后生成的文件（构建产物、覆盖率）不进提交。
3. **越界命令的风险判断是启发式**：只会往高处归，不会把含越界路径的命令降级；路径写在变量或脚本里时识别不到，由 Codex 沙箱兜底。
4. **Codex 沙箱默认允许写系统临时目录**（实测），「worktree 以外不可写」不包括临时目录。
5. **一个 Run 一个 turn**：`native_turn_id` 写入后不改；续做新建 Run 并用 `resumes_run_id` 指回；恢复失败不静默新建会话。
6. **服务被强杀时执行器进程可能残留**：Windows 没有 Job Object，执行器靠 stdin 关闭退出（模拟执行器已验证，真实 Codex 未单独验证）。
7. **审批过期、并发上限、检查超时等都是占位默认值**，集中在 `packages/domain/src/defaults.ts`。
8. **与计划的出入**：worktree 记在子任务上（各次 Run 共用），不在 Run 上；检查命令改为建任务时确认一次（用户决定）；P0 的 `scripts/p0/electron-check.mjs` 由 `scripts/p1/e2e-check.mjs` 取代，macOS 测试包第 5 步随之改用新脚本。
9. **`/simplify` 未采纳的建议**（记录在案）：把 git 与检查命令再抽成端口（用例测试目前用真实 git 和临时仓库，足够快）；`LocalService` 的两段式构造；e2e 脚本与 P0 脚本共用 CDP 工具；模拟执行器路径改为子路径导出；内部状态迁移前的重复读（主键查询，单写者）。

## 推送

本机不能推送，请在仓库目录执行：

```bash
git push -u origin claude/project-thread-8azrof
```

## 下一步建议

1. 推送后看 GitHub Actions 第一次运行结果（Windows、macOS）。
2. Mac 测试回来后对照 `p1-e2e-check.json`。
3. P2：飞书单聊接入同一条任务链路（渠道适配器、身份绑定、审批升级）。
