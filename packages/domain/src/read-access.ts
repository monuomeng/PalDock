/**
 * 项目外只读访问的分层（2026-11-26 已定，0.3.7）。纯函数，不碰文件系统。
 * - 助手这一轮自己生成的文件：自动放行（调用方按文件创建时间判断）；
 * - 敏感路径：只能由你批（协调助手不能批）；
 * - 其余项目外只读：交协调助手判断，它批不了、不确定或超时就回到你这里。
 * 写入、shell 类的权限扩展不走这里，一律由你批。
 */

/** 统一成小写、正斜杠、不带末尾斜杠，便于比较（Windows 路径不分大小写）。 */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 家目录下的敏感位置（凭据、密钥、浏览器配置、执行器自己的配置）。 */
const SENSITIVE_UNDER_HOME = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.password-store',
  '.config/gh',
  '.config/gcloud',
  '.config/git/credentials',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.codex',
  '.claude',
  'appdata/roaming/microsoft/credentials',
  'appdata/roaming/microsoft/protect',
  'appdata/roaming/microsoft/vault',
  'appdata/local/microsoft/credentials',
  'appdata/local/microsoft/vault',
  'appdata/local/google/chrome/user data',
  'appdata/local/microsoft/edge/user data',
  'appdata/local/bravesoftware/brave-browser/user data',
  'appdata/roaming/mozilla/firefox/profiles',
  'library/keychains',
  'library/application support/google/chrome',
  '.mozilla/firefox',
  '.config/google-chrome',
];

const SENSITIVE_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx|keychain))$/;

/**
 * 敏感路径：家目录下的凭据 / 密钥 / 浏览器配置 / ~/.codex、~/.claude，任何位置的 .env*、*.pem、*.key、私钥文件，
 * 以及 extraRoots（PalDock 自己的数据目录之类）。
 */
export function isSensitivePath(path: string, home: string, extraRoots: readonly string[] = []): boolean {
  const p = norm(path);
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (SENSITIVE_NAME.test(name)) return true;
  const h = norm(home);
  const roots = [...SENSITIVE_UNDER_HOME.map((s) => `${h}/${s}`), ...extraRoots.map(norm)];
  return roots.some((root) => p === root || p.startsWith(`${root}/`));
}

/** 一次项目外只读请求怎么处理。 */
export type ReadRoute = 'inside' | 'own_output' | 'sensitive' | 'coordinator' | 'user';

/**
 * 分层：都在项目里 → inside；有敏感路径 → sensitive（只能你批）；都是这一轮生成的 → own_output（自动放行）；
 * 协调助手能判断（发起读取的不是协调助手自己、项目有主会话）→ coordinator；其余 → user。
 */
export function routeRead(input: {
  paths: readonly string[];
  inside: (path: string) => boolean;
  sensitive: (path: string) => boolean;
  createdThisRun: (path: string) => boolean;
  coordinatorAvailable: boolean;
}): ReadRoute {
  const outside = input.paths.filter((p) => !input.inside(p));
  if (input.paths.length > 0 && outside.length === 0) return 'inside';
  if (input.paths.length === 0) return 'user';
  if (outside.some(input.sensitive)) return 'sensitive';
  if (outside.every(input.createdThisRun)) return 'own_output';
  return input.coordinatorAvailable ? 'coordinator' : 'user';
}
