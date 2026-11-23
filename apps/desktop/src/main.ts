import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { COMMAND_NAMES, type CommandName, type PersistentEvent } from '@paldock/contracts';
import { IpcClient } from '@paldock/platform';
import { ServiceHost, type HostStatus } from './service-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(here, '..', 'static', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER).href;

/** 渲染进程只能调用已登记的命令；即便页面被注入脚本，也拿不到令牌或 Node。 */
const RENDERER_COMMANDS = new Set<string>(COMMAND_NAMES);

let window: BrowserWindow | undefined;
let host: ServiceHost | undefined;
let client: IpcClient | undefined;
let lastSeq = 0;

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
      title: '选择 PalDock 数据目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    const dataRoot = picked.filePaths[0];
    if (picked.canceled || !dataRoot) return undefined;
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, JSON.stringify({ dataRoot }));
    return dataRoot;
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

async function onHostStatus(status: HostStatus): Promise<void> {
  // 令牌和管道名只留在主进程
  sendToRenderer('paldock:status', status.state === 'ready' ? { state: 'ready' } : status);
  if (status.state !== 'ready') return;

  await client?.close();
  client = new IpcClient(status.ipcPath, status.token, (event: PersistentEvent) => {
    lastSeq = event.seq;
    sendToRenderer('paldock:event', event);
  });
  client.lastSeq = lastSeq;
  await client.connect();
  sendToRenderer('paldock:status', { state: 'connected', interruptedRuns: status.interruptedRuns });
}

function fromOurRenderer(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url === RENDERER_URL;
}

function registerIpc(): void {
  ipcMain.handle('paldock:request', async (event, name: unknown, args: unknown) => {
    if (!fromOurRenderer(event) || typeof name !== 'string' || !RENDERER_COMMANDS.has(name)) {
      throw new Error('不允许的请求');
    }
    if (!client) throw new Error('本地服务未连接');
    return client.request(name as CommandName, args as never);
  });
  if (!app.isPackaged) {
    ipcMain.handle('paldock:debug:crash', (event) => {
      if (fromOurRenderer(event)) host?.crashForTesting();
    });
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 960,
    height: 680,
    title: 'PalDock（P0 样机）',
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
  void window.loadFile(RENDERER);
}

async function boot(): Promise<void> {
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on('second-instance', () => window?.focus());
  await app.whenReady();

  const dataRoot = await resolveDataRoot();
  if (!dataRoot) return app.quit();
  mkdirSync(dataRoot, { recursive: true });

  registerIpc();
  createWindow();
  host = new ServiceHost(dataRoot, (status) => void onHostStatus(status).catch(() => {}));
  host.start();

  // 生命周期模式 1「随界面退出」：关闭窗口即通知服务收尾后退出
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.resolve(client?.close())
      .then(() => host?.stop())
      .finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}

void boot();
