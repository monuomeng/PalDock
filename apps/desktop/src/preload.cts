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
  // 返回 { ok, value } 或 { ok: false, code, message }：跨 contextBridge 的异常会丢掉错误码，由渲染进程还原
  request: (name: string, args: unknown) => ipcRenderer.invoke('paldock:request', name, args),
  status: () => ipcRenderer.invoke('paldock:status'),
  pickProject: () => ipcRenderer.invoke('paldock:pickProject'),
  onEvent: (listener: Listener) => subscribe('paldock:event', listener),
  onEphemeral: (listener: Listener) => subscribe('paldock:ephemeral', listener),
  onStatus: (listener: Listener) => subscribe('paldock:status', listener),
  debugCrashService: () => ipcRenderer.invoke('paldock:debug:crash'),
});
