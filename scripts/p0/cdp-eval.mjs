// P0 手动验证：Electron 以 --remote-debugging-port=9223 启动后，在渲染页执行表达式（仅开发验证用）
// 通过 CDP 驱动 Electron 渲染页：执行表达式并返回结果
const [,, ...exprs] = process.argv;
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const call = (expression) => new Promise((resolve) => {
  const my = ++id;
  ws.addEventListener('message', function on(e) {
    const m = JSON.parse(e.data);
    if (m.id === my) { ws.removeEventListener('message', on); resolve(m.result?.result?.value ?? m.result); }
  });
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } }));
});
for (const e of exprs) console.log(JSON.stringify(await call(e)));
ws.close();
