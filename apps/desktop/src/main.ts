import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { COMMAND_NAMES, type CommandName, type EphemeralEvent, type PersistentEvent } from '@paldock/contracts';
import { IpcClient } from '@paldock/platform';
import { APP_ORIGIN, registerAppScheme, serveRenderer } from './app-protocol.js';
import { startPowerDiagnostics } from './power-diagnostics.js';
import { ServiceHost, type HostStatus } from './service-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(here, '..', 'static');
const RENDERER_URL = `${APP_ORIGIN}/index.html`;

/** 渲染进程只能调用已登记的命令；即便页面被注入脚本，也拿不到令牌或 Node。 */
const RENDERER_COMMANDS = new Set<string>(COMMAND_NAMES);

registerAppScheme();

let window: BrowserWindow | undefined;
let host: ServiceHost | undefined;
// 整个应用生命周期复用一个客户端：服务重启后用新的管道名和令牌重连，事件序号由客户端自己记住
const client = new IpcClient(
  (event: PersistentEvent) => sendToRenderer('paldock:event', event),
  (event: EphemeralEvent) => sendToRenderer('paldock:ephemeral', event),
);
let connected = false;
let dataRoot: string | undefined;

/**
 * 数据根由用户选择（可选 D 盘）。userData 下只存一个指向数据根的 bootstrap.json；
 * 也可用环境变量 PALDOCK_DATA_ROOT 指定，便于开发和测试。
 */
async function resolveDataRoot(): Promise<string | undefined> {
  if (process.env.PALDOCK_DATA_ROOT) return process.env.PALDOCK_DATA_ROOT;
  const pointer = join(app.getPath('userData'), 'bootstrap.json');
  try {
    return (JSON.parse(readFileSync(pointer, 'utf8')) as { dataRoot: string }).dataRoot;
  } catch {
    const picked = await dialog.showOpenDialog({
      title: '选择 PalDock 数据目录（建议放在 D 盘等非系统盘）',
      properties: ['openDirectory', 'createDirectory'],
    });
    const chosen = picked.filePaths[0];
    if (picked.canceled || !chosen) return undefined;
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, JSON.stringify({ dataRoot: chosen }));
    return chosen;
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

// 每次状态变化递增；异步连接完成时若已有更新的状态，丢弃这次结果
let statusGeneration = 0;
let lastStatus: unknown = { state: 'starting' };

function publishStatus(status: unknown): void {
  lastStatus = status;
  sendToRenderer('paldock:status', status);
}

async function onHostStatus(status: HostStatus): Promise<void> {
  const generation = ++statusGeneration;
  connected = false;
  // 令牌和管道名只留在主进程
  publishStatus(status.state === 'ready' ? { state: 'ready' } : status);
  if (status.state !== 'ready') return;

  await client.close();
  await client.connect(status.ipcPath, status.token);
  if (generation !== statusGeneration) return;
  connected = true;
  publishStatus({ state: 'connected', interruptedRuns: status.interruptedRuns, dataRoot });
}

function fromOurRenderer(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`) ?? false;
}

function registerIpc(): void {
  ipcMain.handle('paldock:request', async (event, name: unknown, args: unknown) => {
    if (!fromOurRenderer(event) || typeof name !== 'string' || !RENDERER_COMMANDS.has(name)) {
      throw new Error('不允许的请求');
    }
    if (!connected) return { ok: false, code: 'unavailable', message: '本地服务未连接' };
    // invoke 抛出的错误会丢掉错误码，所以包成结果对象，由 preload 还原
    try {
      return { ok: true, value: await client.request(name as CommandName, args as never) };
    } catch (error) {
      const { code = 'internal', message } = error as { code?: string; message: string };
      return { ok: false, code, message };
    }
  });
  // 窗口重建（刷新页面）后先拿到当前连接状态
  ipcMain.handle('paldock:status', (event) => (fromOurRenderer(event) ? lastStatus : undefined));
  // 选项目目录只能经主进程的系统对话框；渲染进程拿不到任意路径的读写能力
  ipcMain.handle('paldock:pickProject', async (event) => {
    if (!fromOurRenderer(event) || !window) return undefined;
    const picked = await dialog.showOpenDialog(window, { title: '选择项目（git 仓库根目录）', properties: ['openDirectory'] });
    return picked.canceled ? undefined : picked.filePaths[0];
  });
  if (!app.isPackaged) {
    ipcMain.handle('paldock:debug:crash', (event) => {
      if (fromOurRenderer(event)) host?.crashForTesting();
    });
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'PalDock',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 禁止导航和新窗口：页面只能是本地打包的管理界面
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void window.loadURL(RENDERER_URL);
}

async function boot(): Promise<void> {
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  await app.whenReady();

  dataRoot = await resolveDataRoot();
  if (!dataRoot) return app.quit();
  mkdirSync(dataRoot, { recursive: true });

  serveRenderer(STATIC_DIR);
  registerIpc();
  if (process.env.PALDOCK_DIAGNOSTICS === '1') startPowerDiagnostics(dataRoot);
  createWindow();
  host = new ServiceHost(dataRoot, (status) => void onHostStatus(status).catch(() => {}));
  host.start();

  // 生命周期模式 1「随界面退出」：关闭窗口即通知服务收尾后退出
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void client
      .close()
      .then(() => host?.stop())
      .finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}

void boot();
