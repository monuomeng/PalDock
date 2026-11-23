// P0-04 worktree 放在数据根下的可行性检查（Windows / macOS 通用）。
// 用法：在仓库根目录运行 `node scripts/p0/worktree-check.mjs`。只在临时目录里建测试仓库，不碰任何真实项目。
// 关注：Windows 长路径（MAX_PATH 260）、macOS 默认不区分大小写的文件系统对分支名和文件名的影响。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'pd-wt-'));
const repo = join(base, 'project');
const dataRoot = join(base, 'data');
const results = [];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, value: String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ') };
  }
};
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail: String(detail) });
  console.log(`${pass ? 'PASS' : 'INFO'}  ${name}${detail ? `  (${detail})` : ''}`);
};

mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 'probe@example.invalid');
git(repo, 'config', 'user.name', 'PalDock probe');
writeFileSync(join(repo, 'a.txt'), 'a');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'init');

const caseSensitive = !existsSync(join(repo, 'A.TXT'));
record('文件系统区分大小写', true, caseSensitive ? '是' : '否（macOS / Windows 默认）');
record('core.ignorecase', true, attempt(() => git(repo, 'config', '--get', 'core.ignorecase')).value || '未设置');

// 数据根下的 worktree
const wt = join(dataRoot, 'worktrees', 'task-0001');
const added = attempt(() => git(repo, 'worktree', 'add', '-q', '-b', 'paldock/task-0001', wt));
record('在数据根下创建 worktree', added.ok, added.ok ? wt : added.value);

// 只有大小写不同的两个分支名
const branchA = attempt(() => git(repo, 'branch', 'paldock/Fix-Login'));
const branchB = attempt(() => git(repo, 'branch', 'paldock/fix-login'));
record('只差大小写的两个分支可以共存', branchA.ok && branchB.ok, branchB.ok ? '两个都建成' : branchB.value);

// 只有大小写不同的两个文件（在区分大小写的系统上提交，再到不区分的系统上检出会冲突）
writeFileSync(join(wt, 'Readme.md'), '1');
const second = attempt(() => (writeFileSync(join(wt, 'README.md'), '2'), readdirSync(wt).filter((f) => /^readme\.md$/i.test(f)).length));
record('只差大小写的两个文件可以同时存在', second.ok && second.value === 2, `目录里实际有 ${second.value} 个`);

// 深层路径：worktree 根 + 项目内常见的深目录（node_modules 等）
const deep = join(wt, ...Array.from({ length: 12 }, (_, i) => `node_modules_level_${i}`));
const deepFile = join(deep, 'index.js');
const deepWrite = attempt(() => (mkdirSync(deep, { recursive: true }), writeFileSync(deepFile, 'x'), deepFile.length));
record('写入超过 260 字符的路径', deepWrite.ok, `长度 ${deepFile.length}${deepWrite.ok ? '' : `：${deepWrite.value}`}`);
const deepAdd = attempt(() => (git(wt, 'add', '-A'), git(wt, 'commit', '-q', '-m', 'deep'), 'ok'));
record('git 提交超过 260 字符的路径', deepAdd.ok, deepAdd.ok ? '' : deepAdd.value);
if (process.platform === 'win32') {
  const longpaths = attempt(() => git(repo, 'config', '--get', 'core.longpaths'));
  record('core.longpaths', true, longpaths.ok ? longpaths.value : '未设置');
}

// Windows 上不开 core.longpaths 时，删除含超长路径的 worktree 会报 Filename too long（P0-04 实测），
// 且此时 worktree 已被注销、文件残留。PalDock 对 worktree 的 git 命令统一带上该参数。
const longpathsArgs = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
const removed = attempt(() => git(repo, ...longpathsArgs, 'worktree', 'remove', '--force', wt));
record('删除含超长路径的 worktree', removed.ok, removed.ok ? longpathsArgs.join(' ') : removed.value);

rmSync(base, { recursive: true, force: true });
const report = {
  checkedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
  results,
};
writeFileSync(resolve(import.meta.dirname, '..', '..', 'p0-worktree-check.json'), JSON.stringify(report, null, 2));
console.log('\n→ p0-worktree-check.json');
