import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface Credential {
  user: string;
  secret: string;
}

/**
 * 系统凭据库：Windows 凭据管理器（通用凭据）、macOS 登录钥匙串（通用密码）。
 * 秘密只经子进程的 stdin / stdout 进出内存，不落盘、不进日志、不进命令行参数（target 和用户名不是秘密）。
 * Windows 用户也可以手动 `cmdkey /generic:<target> /user:<id> /pass` 写入，PalDock 读到的是同一条。
 */

const exec = promisify(execFile);
const TIMEOUT_MS = 20_000;

// Node 没有内置接口，经 PowerShell 调 Win32 CredRead / CredWrite / CredDelete
const WIN_TYPES = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class PalDockCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
'@
`;

const WIN_READ = `${WIN_TYPES}
$ptr = [IntPtr]::Zero
if (-not [PalDockCred]::CredRead($env:PALDOCK_CRED_TARGET, 1, 0, [ref]$ptr)) { exit 2 }
$c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][PalDockCred+CREDENTIAL])
$secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
[PalDockCred]::CredFree($ptr)
[Console]::Out.Write((@{ user = $c.UserName; secret = $secret } | ConvertTo-Json -Compress))
`;

// 秘密从 stdin 读入；Persist = 2（LOCAL_MACHINE：本机当前用户，跨登录保留，不随漫游配置同步）
const WIN_WRITE = `${WIN_TYPES}
$secret = [Console]::In.ReadToEnd()
$c = New-Object PalDockCred+CREDENTIAL
$c.Type = 1; $c.Persist = 2
$c.TargetName = $env:PALDOCK_CRED_TARGET; $c.UserName = $env:PALDOCK_CRED_USER
$c.CredentialBlob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret)
$c.CredentialBlobSize = $secret.Length * 2
try { if (-not [PalDockCred]::CredWrite([ref]$c, 0)) { exit 3 } }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($c.CredentialBlob) }
`;

const WIN_DELETE = `${WIN_TYPES}
if (-not [PalDockCred]::CredDelete($env:PALDOCK_CRED_TARGET, 1, 0)) { exit 2 }
`;

function powershell(script: string, env: Record<string, string>, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(input ?? '');
  });
}

/** macOS `security -i` 从 stdin 读命令，秘密因此不出现在进程参数里；按它的引号规则转义。 */
const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

function securityInteractive(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', ['-i'], { timeout: TIMEOUT_MS }, (error, _stdout, stderr) =>
      error || stderr.trim() ? reject(error ?? new Error('钥匙串写入失败')) : resolve(),
    );
    child.stdin?.end(`${command}\n`);
  });
}

/** 删掉某个服务下的全部条目（delete-generic-password 一次只删一条，没有时报错）。 */
async function deleteKeychainItems(target: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await exec('/usr/bin/security', ['delete-generic-password', '-s', target], { timeout: TIMEOUT_MS });
    } catch {
      return;
    }
  }
}

/** `security find-generic-password -w` 的输出；`-g` 的 stderr 显示为 `password: 0x…` 时，输出是 UTF-8 字节的十六进制。 */
export function keychainSecret(wOutput: string, gStderr: string): string {
  const value = wOutput.replace(/\n$/, '');
  return /^password: 0x[0-9A-F]+/m.test(gStderr) ? Buffer.from(value, 'hex').toString('utf8') : value;
}

const unsupported = () => new Error('凭据库目前只支持 Windows 与 macOS');

export async function readCredential(target: string): Promise<Credential | undefined> {
  try {
    if (process.platform === 'win32') return JSON.parse(await powershell(WIN_READ, { PALDOCK_CRED_TARGET: target })) as Credential;
    if (process.platform === 'darwin') {
      // -g 把属性写到 stdout、密码写到 stderr；密码含非 ASCII 字符时两种输出都是十六进制（`password: 0x…`），要解码。
      const { stdout: attributes, stderr } = await exec('/usr/bin/security', ['find-generic-password', '-s', target, '-g'], { timeout: TIMEOUT_MS });
      const user = /"acct"<blob>="(.*)"/.exec(attributes)?.[1] ?? '';
      const { stdout: secret } = await exec('/usr/bin/security', ['find-generic-password', '-s', target, '-w'], { timeout: TIMEOUT_MS });
      return { user, secret: keychainSecret(secret, stderr) };
    }
  } catch {
    return undefined;
  }
  throw unsupported();
}

/** 已有同名凭据时覆盖。 */
export async function writeCredential(target: string, credential: Credential): Promise<void> {
  if (process.platform === 'win32') {
    await powershell(WIN_WRITE, { PALDOCK_CRED_TARGET: target, PALDOCK_CRED_USER: credential.user }, credential.secret);
    return;
  }
  if (process.platform === 'darwin') {
    // 钥匙串按「服务 + 账户」区分条目，`-U` 只覆盖账户相同的那条；飞书换了 App ID（账户）时会多出一条，
    // 而读取只取第一条。所以先删掉这个服务下的所有条目再写。
    await deleteKeychainItems(target);
    return securityInteractive(`add-generic-password -s ${quote(target)} -a ${quote(credential.user)} -w ${quote(credential.secret)}`);
  }
  throw unsupported();
}

/** 不存在时视为已删除。 */
export async function deleteCredential(target: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await powershell(WIN_DELETE, { PALDOCK_CRED_TARGET: target });
      return;
    }
    if (process.platform === 'darwin') return await deleteKeychainItems(target);
  } catch {
    return;
  }
  throw unsupported();
}
