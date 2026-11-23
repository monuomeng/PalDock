import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface Credential {
  user: string;
  secret: string;
}

/**
 * 从 Windows 凭据管理器读取通用凭据（用户用 `cmdkey /generic:<target> /user:<id> /pass` 写入）。
 * Node 没有内置接口，P0 经 PowerShell 调 Win32 CredRead；秘密只经子进程 stdout 进入内存，
 * 不落盘、不进日志、不进命令行参数（target 名称不是秘密）。P1 评估原生模块或 Electron safeStorage。
 * macOS 钥匙串实现待补。
 */
const READ_SCRIPT = `
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
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
'@
$ptr = [IntPtr]::Zero
if (-not [PalDockCred]::CredRead($env:PALDOCK_CRED_TARGET, 1, 0, [ref]$ptr)) { exit 2 }
$c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][PalDockCred+CREDENTIAL])
$secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
[PalDockCred]::CredFree($ptr)
[Console]::Out.Write((@{ user = $c.UserName; secret = $secret } | ConvertTo-Json -Compress))
`;

export async function readCredential(target: string): Promise<Credential | undefined> {
  if (process.platform !== 'win32') throw new Error('凭据读取目前只实现了 Windows');
  try {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', READ_SCRIPT],
      { env: { ...process.env, PALDOCK_CRED_TARGET: target }, windowsHide: true, timeout: 20_000 },
    );
    return JSON.parse(stdout) as Credential;
  } catch {
    return undefined;
  }
}
