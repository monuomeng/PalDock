// 沙箱化的 preload 只能是 CommonJS，且只能用 electron 的受限子集。
// 渲染进程拿到的是白名单方法，不是 ipcRenderer 本身。
import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

type Listener = (payload: unknown) => void;

function subscribe(channel: string, listener: Listener): () => void {
  const wrapped = (_event: electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

contextBridge.exposeInMainWorld('paldock', {
  request: (name: string, args: unknown) => ipcRenderer.invoke('paldock:request', name, args),
  onEvent: (listener: Listener) => subscribe('paldock:event', listener),
  onStatus: (listener: Listener) => subscribe('paldock:status', listener),
  debugCrashService: () => ipcRenderer.invoke('paldock:debug:crash'),
});
