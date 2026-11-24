// P1 桌面端到端检查（Windows / macOS 通用）：真实 Electron 窗口 + 本地服务 + 离线模拟 Codex + 临时 git 仓库。
// 用法：先 `pnpm install && pnpm build`，再在仓库根目录运行 `node scripts/p1/e2e-check.mjs`。
// 数据写在临时目录，不碰用户数据，不调用任何模型或外部服务。结果写到 ./p1-e2e-check.json，截图写到 ./p1-e2e-*.png。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const appDir = join(root, 'apps', 'desktop');
const electron = createRequire(join(appDir, 'package.json'))('electron');
const port = 9300 + Math.floor(Math.random() * 500);
const work = mkdtempSync(join(tmpdir(), 'pd-p1-e2e-'));
const dataRoot = join(work, 'data');
const repo = join(work, 'demo repo');
const env = {
  ...process.env,
  PALDOCK_DATA_ROOT: dataRoot,
  // 独立的 userData：不与本机已安装、正在运行的 PalDock 争单实例锁
  PALDOCK_USER_DATA: join(work, 'user-data'),
  PALDOCK_CODEX_PATH: join(root, 'packages', 'runtime-codex', 'mock', 'mock-app-server.mjs'),
  // 模拟执行器把 thread 存在 CODEX_HOME 下（CODEX_HOME 在执行器环境变量白名单里）
  CODEX_HOME: join(work, 'mock-home'),
};
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail ?? '') });
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

/** 连上渲染页的 CDP：evaluate 执行表达式，screenshot 保存截图。 */
async function connectPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => (ws.addEventListener('open', r), ws.addEventListener('error', j)));
        let id = 0;
        const send = (method, params) =>
          new Promise((done) => {
            const my = ++id;
            ws.addEventListener('message', function on(e) {
              const m = JSON.parse(e.data);
              if (m.id !== my) return;
              ws.removeEventListener('message', on);
              done(m.result);
            });
            ws.send(JSON.stringify({ id: my, method, params }));
          });
        const evaluate = async (expression) =>
          (await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true }))?.result?.value;
        const screenshot = async (name) => {
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          if (shot?.data) writeFileSync(join(root, `p1-e2e-${name}.png`), Buffer.from(shot.data, 'base64'));
        };
        return { evaluate, screenshot };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('无法连接到 Electron 调试端口');
}

/** 轮询表达式直到为真值，返回最后一次的值。 */
async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(expression).catch(() => undefined);
    if (value) return value;
    await sleep(250);
  }
  return value;
}

const text = (selector) => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`;
const connectedExpr = `${text('#connection')}.includes('已连接')`;
const goto = (hash) => `(location.hash = ${JSON.stringify(hash)}, true)`;
const clickButton = (label) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`;
const request = (name, args) => `window.paldock.request(${JSON.stringify(name)}, ${JSON.stringify(args)})`;

function makeRepo() {
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git('add', '-A');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init');
}

/** 通过新建任务表单提交（项目路径由脚本填入，真实使用时由系统对话框选择）。 */
async function createViaForm(evaluate, goal) {
  await evaluate(goto('#/new'));
  await waitFor(evaluate, `!!document.querySelector('form.new-task')`);
  return evaluate(`(() => {
    const form = document.querySelector('form.new-task');
    form.querySelector('#project').value = ${JSON.stringify(repo)};
    form.querySelector('#goal').value = ${JSON.stringify(goal)};
    form.querySelector('#check-exe').value = ${JSON.stringify(process.execPath)};
    form.querySelector('#check-args').value = "-e\\nconsole.log('password=hunter2 ok')";
    form.querySelector('#check-confirmed').checked = true;
    form.requestSubmit();
    return true;
  })()`);
}

const currentTaskId = `decodeURIComponent(location.hash.split('/')[2]?.split('?')[0] ?? '')`;

makeRepo();
let app = launch([`--remote-debugging-port=${port}`]);
try {
  let { evaluate, screenshot } = await connectPage();
  check('启动后连上本地服务', await waitFor(evaluate, connectedExpr));
  check('渲染进程拿不到 Node', (await evaluate(`typeof require + ',' + typeof process`)) === 'undefined,undefined');
  check(
    'preload 只暴露白名单方法',
    (await evaluate(`Object.keys(window.paldock).sort().join(',')`)) === 'debugCrashService,onEphemeral,onEvent,onStatus,pickProject,request,status',
  );
  check('未登记的命令被拒绝', (await evaluate(`window.paldock.request('fs.deleteAll',{}).then(()=>'allowed',()=>'rejected')`)) === 'rejected');
  check('页面经自定义协议加载', (await evaluate('location.protocol')) === 'paldock:');
  if (process.platform !== 'win32') {
    const sock = join(dataRoot, 'paldock.sock');
    const mode = existsSync(sock) ? (statSync(sock).mode & 0o777).toString(8) : 'missing';
    check('Unix 套接字权限为 600', mode === '600', `mode=${mode}`);
  }

  // 主流程：表单建任务 → 执行 → 回显 → 待验收 → 验收
  await createViaForm(evaluate, '加一个文件');
  check(
    '提交后跳到任务详情',
    await waitFor(evaluate, `location.hash.startsWith('#/task/')`),
    await evaluate(`location.hash + ' ' + (document.querySelector('.error')?.textContent ?? '')`),
  );
  const review = await waitFor(evaluate, `${text('.task-detail .facts .status')} === '待验收'`);
  check('执行完成后进入待验收', review);
  check('输出回显到页面', (await evaluate(text('pre.output'))).includes('完成'));
  check('证据含改动统计', (await evaluate(text('pre.diffstat'))).includes('mock-change.txt'));
  check('检查命令通过', (await evaluate(text('.check'))) === '通过');
  await evaluate(clickButton('查看输出（已脱敏）'));
  const checkOutput = await waitFor(evaluate, `${text('pre.check-output')} || false`);
  check('检查输出已脱敏', checkOutput?.includes('password=[已脱敏]') && !checkOutput.includes('hunter2'), checkOutput);
  await screenshot('review');
  await evaluate(clickButton('验收通过'));
  check('验收后任务完成', await waitFor(evaluate, `${text('.task-detail .facts .status')} === '已完成'`));

  // 审批：A 停在审批；B 待验收
  const a = await evaluate(`${request('task.create', { rootPath: repo, goal: '[mock:file-approval] A', idempotencyKey: 'e2e-a-0001' })}.then((r) => r.value.task.id)`);
  const b = await evaluate(`${request('task.create', { rootPath: repo, goal: 'B', idempotencyKey: 'e2e-b-0001' })}.then((r) => r.value.task.id)`);
  await evaluate(goto('#/attention'));
  const kinds = await waitFor(evaluate, `(() => { const k = [...document.querySelectorAll('.attention-item .kind')].map((e) => e.textContent).sort().join(','); return k === '审批,待验收' ? k : false; })()`);
  check('「待我处理」列出 A 的审批与 B 的待验收', kinds, kinds);
  await screenshot('attention');
  await evaluate(`[...document.querySelectorAll('.attention-item')].find((b) => b.textContent.includes('审批')).click()`);
  check('点开审批直达 A 的详情', await waitFor(evaluate, `${currentTaskId} === ${JSON.stringify(a)} && !!document.querySelector('.approval.pending')`));
  await screenshot('approval');
  await evaluate(goto('#/attention'));
  check(
    '点开后只记已读，待办仍在',
    await waitFor(evaluate, `[...document.querySelectorAll('li.read .kind')].some((e) => e.textContent === '审批')`),
  );
  await evaluate(`location.reload()`);
  await sleep(1500);
  ({ evaluate, screenshot } = await connectPage());
  check('窗口重载后审批仍在', await waitFor(evaluate, `${connectedExpr} && document.querySelectorAll('.attention-item').length === 2`));
  await evaluate(goto(`#/task/${a}`));
  await waitFor(evaluate, `!!document.querySelector('.approval.pending')`);
  await evaluate(clickButton('拒绝'));
  check('拒绝 A 后 A 进入待验收', await waitFor(evaluate, `${text('.task-detail .facts .status')} === '待验收'`));
  await evaluate(goto('#/attention'));
  check('拒绝只移除 A 的审批', await waitFor(evaluate, `[...document.querySelectorAll('.attention-item .kind')].filter((e) => e.textContent === '审批').length === 0`));

  // 退回 B：旧证据保留，新一轮成为当前验收对象
  await evaluate(goto(`#/task/${b}`));
  await waitFor(evaluate, `!!document.querySelector('#review-note')`);
  await evaluate(`(document.querySelector('#review-note').value = '补测试', true)`);
  await evaluate(clickButton('退回重做'));
  check('退回后 B 重跑并再次待验收，旧证据仍在', await waitFor(evaluate, `document.querySelectorAll('details.run').length === 2 && ${text('.task-detail .facts .status')} === '待验收'`));
  check('旧一次的退回意见可查', (await evaluate(text('.review-note'))).includes('补测试'));

  // 取消
  const slow = await evaluate(`${request('task.create', { rootPath: repo, goal: '[mock:slow] 慢任务', idempotencyKey: 'e2e-slow-01' })}.then((r) => r.value.task.id)`);
  await evaluate(goto(`#/task/${slow}`));
  await waitFor(evaluate, `${text('details.run summary')}.includes('执行中')`);
  await evaluate(clickButton('取消任务'));
  check('执行中取消', await waitFor(evaluate, `${text('.task-detail .facts .status')} === '已取消'`));

  // 服务崩溃：进行中的 Run 被中断，重启后出现在「待我处理」，可恢复
  const crash = await evaluate(`${request('task.create', { rootPath: repo, goal: '[mock:slow] 崩溃中的任务', idempotencyKey: 'e2e-crash-1' })}.then((r) => r.value.task.id)`);
  await evaluate(goto(`#/task/${crash}`));
  await waitFor(evaluate, `${text('details.run summary')}.includes('执行中')`);
  await evaluate(`window.paldock.debugCrashService()`);
  check('服务被结束后显示重启倒计时', await waitFor(evaluate, `${text('#connection')}.includes('重启')`, 5000));
  check('自动重启并重连', await waitFor(evaluate, connectedExpr, 20000));
  check('被中断的任务显示阻塞与原因', await waitFor(evaluate, `${text('.panel.blocked')}.includes('服务重启')`));
  await screenshot('blocked');
  await evaluate(clickButton('恢复'));
  check('恢复后续做完成（新 Run 指回原 Run）', await waitFor(evaluate, `${text('.task-detail .facts .status')} === '待验收' && ${text('details.run[open]')}.includes('续做自')`, 30000));

  // 第二个实例
  const second = launch();
  const secondExit = await Promise.race([second.exited, sleep(15000).then(() => 'timeout')]);
  if (secondExit === 'timeout') second.kill();
  check('第二个实例立即退出', secondExit !== 'timeout', JSON.stringify(secondExit));
  check('页面不能跳转到外部网址', (await evaluate(`(location.href='https://example.com', await new Promise(r=>setTimeout(r,1000)), location.protocol)`)) === 'paldock:');

  // 正常退出与跨启动持久化
  evaluate(`setTimeout(() => window.close(), 50)`).catch(() => {});
  const exit = await Promise.race([app.exited, sleep(40000).then(() => 'timeout')]);
  check('关闭窗口后应用在 40 秒内退出', exit !== 'timeout', JSON.stringify(exit));
  const left = readdirSync(dataRoot);
  check('正常退出后 PID 锁与套接字已清理', !left.includes('paldock.lock') && !left.includes('paldock.sock'), left.join(' '));

  app = launch([`--remote-debugging-port=${port}`]);
  ({ evaluate, screenshot } = await connectPage());
  await waitFor(evaluate, connectedExpr);
  await evaluate(goto('#/tasks'));
  check('重新打开后任务列表仍在', await waitFor(evaluate, `document.querySelectorAll('table.tasks tbody tr').length === 5`));
  await screenshot('tasks');
  evaluate(`setTimeout(() => window.close(), 50)`).catch(() => {});
  await Promise.race([app.exited, sleep(40000)]);
} catch (error) {
  check('检查脚本运行', false, error.stack ?? error.message);
  app.kill();
}

const report = {
  checkedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
  appOutputTail: app.output.split('\n').slice(-40),
};
writeFileSync(join(root, 'p1-e2e-check.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed → p1-e2e-check.json`);
if (report.failed === 0 && existsSync(work)) rmSync(work, { recursive: true, force: true, maxRetries: 5 });
process.exit(report.failed === 0 ? 0 : 1);
