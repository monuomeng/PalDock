# 数据、备份与卸载

适用于 P1 开发预览（Windows 为主，macOS 路径见括注）。PalDock 不收集遥测，所有业务数据都在你首次启动时选定的**数据目录**里。

## 数据放在哪里

首次启动时选择数据目录，默认建议放在**安装目录旁边**：装在 `D:\software\PalDock` 时默认为 `D:\software\PalDockData`（可以改）。数据目录**不能放在安装目录里**：卸载会删除整个安装目录，升级时安装程序也会先卸载旧版本，数据会一起被删；选到安装目录或系统、程序目录里时，PalDock 会说明原因并让你重选。已经选好的数据目录不受影响。

| 位置 | 内容 | 卸载时是否删除 |
|---|---|---|
| 安装目录（安装时选择，可放 D 盘） | 程序文件 | 删除 |
| `%APPDATA%\PalDock\bootstrap.json`（macOS：`~/Library/Application Support/PalDock/bootstrap.json`） | 只记一行：数据目录在哪里 | **不删除** |
| 数据目录 `paldock.db`（及 `-wal`、`-shm`） | 任务、执行记录、审批、验收意见、执行器输出、事件 | **不删除** |
| 数据目录 `artifacts/checks/` | 检查命令的输出（已脱敏） | **不删除** |
| 数据目录 `worktrees/` | 每个任务一个 git worktree（执行器在这里改代码） | **不删除** |
| 数据目录 `backups/` | 升级前自动备份、手动备份 | **不删除** |
| 你的项目仓库里的 `paldock/<编号>` 分支 | 验收通过时提交的改动 | **不删除** |
| Codex 自己的历史（`%USERPROFILE%\.codex`） | Codex 的原生会话，由 Codex 管理 | 不属于 PalDock |
| 系统凭据管理器（钥匙串） | P1 不保存任何凭据 | — |

## 备份

**手动备份**：在「任务」页点「备份数据」。备份写到 `数据目录\backups\manual-<时间>\`，内含：

- `paldock.db`：用 SQLite 在线备份生成，服务运行时也能做，得到一致的快照；
- `artifacts\`：证据文件的完整副本（先复制产物、再备份数据库，保证库里引用的文件都在备份中）。

**升级前自动备份**：数据库结构升级前，PalDock 自动把旧库备份到 `backups\paldock-v<旧版本>-<时间>.db`。**只含数据库，不含 artifacts。**

**不在备份范围内**：

- worktree 里**没有提交**的改动（已验收的改动在项目仓库的 `paldock/` 分支里，随你的仓库备份）；
- Codex 的原生会话：从备份恢复后，旧的执行记录可能无法再「恢复」（续做），只能「重新开始」；
- 凭据（P1 不保存）。

## 从备份恢复

1. 完全退出 PalDock（关闭窗口即退出；确认任务管理器里没有 PalDock 进程）。
2. 把数据目录里现有的 `paldock.db`、`paldock.db-wal`、`paldock.db-shm` 和 `artifacts\` 移到别处保留。
3. 把备份目录里的 `paldock.db` 和 `artifacts\` 复制回数据目录。
4. 启动 PalDock。如果备份时有任务正在执行，它们会显示为「阻塞（服务重启）」，由你选择恢复、重新开始或放弃。若某次执行的证据文件不在备份里，详情页会显示「证据文件缺失」，不影响其他数据。

## 卸载

1. 退出 PalDock，在「设置 → 应用」（macOS：把应用拖到废纸篓）卸载。卸载程序**只删除程序文件**，不会删除你的数据目录、worktree 和分支，避免误删工作成果。
2. 如需彻底清理，再手动执行：
   - 删除数据目录（先确认里面的 `worktrees\` 没有你还需要的改动）；
   - 在每个用过的项目仓库里清理 worktree 记录和分支：

     ```bash
     git worktree prune
     git branch --list "paldock/*"
     git branch -D paldock/<编号>
     ```

     Windows 上 worktree 路径很长时，删除前先运行 `git -c core.longpaths=true worktree prune`，否则可能报 `Filename too long` 并残留文件；
   - 删除 `%APPDATA%\PalDock\`（含 `bootstrap.json`）。下次安装会重新让你选择数据目录。
