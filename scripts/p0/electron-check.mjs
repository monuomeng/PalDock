// P0-04 Electron 实机自动检查（Windows / macOS 通用）。
// 用法：先 `pnpm install && pnpm build`，再在仓库根目录运行 `node scripts/p0/electron-check.mjs`。
// 会启动真实的 PalDock 窗口（几秒后自动关闭），数据写在临时目录，不碰用户数据。
// 结果写到 ./p0-electron-check.json，同时打印到终端。不调用任何模型或外部服务。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const appDir = join(root, 'apps', 'desktop');
const electron = createRequire(join(appDir, 'package.json'))('electron');
const port = 9300 + Math.floor(Math.random() * 500);
const dataRoot = mkdtempSync(join(tmpdir(), 'pd-e2e-'));
const env = { ...process.env, PALDOCK_DATA_ROOT: dataRoot, PALDOCK_DIAGNOSTICS: '1' };
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function launch(extraArgs = []) {
  const child = spawn(electron, [appDir, ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => (child.output += d));
  child.stderr.on('data', (d) => (child.output += d));
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return child;
}

async function connectPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => (ws.addEventListener('open', r), ws.addEventListener('error', j)));
        let id = 0;
        return (expression) =>
          new Promise((done) => {
            const my = ++id;
            ws.addEventListener('message', function on(e) {
              const m = JSON.parse(e.data);
              if (m.id !== my) return;
              ws.removeEventListener('message', on);
              done(m.result?.result?.value);
            });
            ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } }));
          });
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('无法连接到 Electron 调试端口');
}

async function waitForStatus(evaluate, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await evaluate(`document.getElementById('status').textContent`);
    if (status?.includes(text)) return status;
    await sleep(300);
  }
  return evaluate(`document.getElementById('status').textContent`);
}

const app = launch([`--remote-debugging-port=${port}`]);
try {
  const evaluate = await connectPage();
  check('启动后连上本地服务', (await waitForStatus(evaluate, '已连接', 20000))?.includes('已连接'));
  check('渲染进程拿不到 Node', (await evaluate(`typeof require + ',' + typeof process`)) === 'undefined,undefined');
  check('preload 只暴露白名单方法', (await evaluate(`Object.keys(window.paldock).sort().join(',')`)) === 'debugCrashService,onEvent,onStatus,request');
  check('未登记的命令被拒绝', (await evaluate(`window.paldock.request('fs.deleteAll',{}).then(()=>'allowed',()=> 'rejected')`)) === 'rejected');

  const events = await evaluate(`(document.getElementById('create-task').click(), await new Promise(r=>setTimeout(r,800)), document.getElementById('queue-task').click(), await new Promise(r=>setTimeout(r,800)), document.querySelectorAll('#events li').length)`);
  check('新建任务并改状态，事件推送到页面', events === 2, `events=${events}`);

  const files = readdirSync(dataRoot);
  check('数据根下有数据库和 PID 锁', files.includes('paldock.db') && files.includes('paldock.lock'), files.join(' '));
  if (process.platform !== 'win32') {
    const sock = join(dataRoot, 'paldock.sock');
    const mode = existsSync(sock) ? (statSync(sock).mode & 0o777).toString(8) : 'missing';
    check('Unix 套接字权限为 600', mode === '600', `mode=${mode} path=${sock}`);
  }

  await evaluate(`window.paldock.debugCrashService()`);
  const restarting = await waitForStatus(evaluate, '重启', 5000);
  check('服务被结束后进入重启倒计时', restarting?.includes('重启'), restarting);
  check('3 秒后自动重启并重连', (await waitForStatus(evaluate, '已连接', 15000))?.includes('已连接'));
  const seq = await evaluate(`(document.getElementById('create-task').click(), await new Promise(r=>setTimeout(r,800)), document.querySelector('#events li')?.textContent.split(' ')[0])`);
  check('重启后事件序号接续', seq === '#3', `latest=${seq}`);

  const second = launch();
  const secondExit = await Promise.race([second.exited, sleep(15000).then(() => 'timeout')]);
  if (secondExit === 'timeout') second.kill();
  check('第二个实例立即退出', secondExit !== 'timeout', JSON.stringify(secondExit));

  check('页面不能跳转到外部网址', (await evaluate(`(location.href='https://example.com', await new Promise(r=>setTimeout(r,1000)), location.protocol)`)) === 'file:');

  evaluate(`setTimeout(() => window.close(), 50)`).catch(() => {});
  const exit = await Promise.race([app.exited, sleep(40000).then(() => 'timeout')]);
  check('关闭窗口后应用在 40 秒内退出', exit !== 'timeout', JSON.stringify(exit));
  const left = readdirSync(dataRoot);
  check('正常退出后 PID 锁已删除', !left.includes('paldock.lock'), left.join(' '));
  check('正常退出后套接字已清理', !left.includes('paldock.sock'), left.join(' '));
} catch (error) {
  check('检查脚本运行', false, error.message);
  app.kill();
}

const diagnostics = join(dataRoot, 'diagnostics.log');
const report = {
  checkedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
  diagnostics: existsSync(diagnostics) ? readFileSync(diagnostics, 'utf8').trim().split('\n') : [],
  appOutputTail: app.output.split('\n').slice(-30),
};
writeFileSync(join(root, 'p0-electron-check.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed → p0-electron-check.json`);
process.exit(report.failed === 0 ? 0 : 1);
