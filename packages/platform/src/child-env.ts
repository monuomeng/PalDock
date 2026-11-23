/**
 * 子进程（执行器、检查命令）的环境变量白名单。
 * 从 Claude 桌面版或另一个代理会话里启动时，会继承几十个宿主变量（CLAUDE_*、ELECTRON_* 等），
 * 子进程可能因此挂到宿主会话上（P0-02 实测），所以只传运行所需的最小集合。
 * PalDock 自身的令牌、管道名从不放进环境变量。
 */
const ALLOWED = [
  // 系统与路径
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // 用户目录
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  // 临时目录与语言
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // 网络：用户配置的代理与证书（在中国大陆访问模型服务通常需要）
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Codex 自己的配置与历史目录
  'CODEX_HOME',
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED);

/**
 * 按白名单复制环境变量（Windows 上变量名不区分大小写，保留原始写法），再合并 extra。
 * extra 中值为 undefined 的键会被删除。
 */
export function childEnv(extra: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED_SET.has(key.toUpperCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * 在 Electron 的本地服务进程里，process.execPath 是 Electron 可执行文件；
 * 用它跑 Node 脚本必须带 ELECTRON_RUN_AS_NODE=1。
 */
export function nodeRuntimeEnv(command: string): Record<string, string> {
  return process.versions.electron && command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}
