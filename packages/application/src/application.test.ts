import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '@paldock/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planSpawn, runCheck } from './check-runner.js';
import { redact } from './redact.js';
import { isInside } from '@paldock/platform';
import { operationOf } from './risk.js';
import { titleOf } from './prompts.js';

const windows = process.platform === 'win32';

describe('检查命令', () => {
  let dir: string;
  let script: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'paldock 检查 '));
    script = join(dir, '回显 args.js');
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const opts = () => ({ cwd: dir, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });

  it('可执行文件与参数原样传入：带空格与中文的路径、cmd 元字符', async () => {
    const args = [script, 'a b', '中 文', '&|<>^()', "it's", '--flag=x y'];
    const outcome = await runCheck({ executable: process.execPath, args }, opts());
    expect(outcome).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(JSON.parse(outcome.output)).toEqual(args.slice(1));
  });

  it('退出码非零为 failed；找不到可执行文件为 error', async () => {
    expect(await runCheck({ executable: process.execPath, args: ['-e', 'process.exit(3)'] }, opts())).toMatchObject({
      status: 'failed',
      exitCode: 3,
    });
    expect(await runCheck({ executable: 'paldock-no-such-command', args: [] }, opts())).toMatchObject({ status: 'error' });
  });

  it('超时与取消会结束进程树', async () => {
    const forever = { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
    expect(await runCheck(forever, { ...opts(), timeoutMs: 200 })).toMatchObject({ status: 'timed_out' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await runCheck(forever, { ...opts(), signal: controller.signal })).toMatchObject({ status: 'cancelled' });
  });

  it('输出超过上限时截断', async () => {
    const outcome = await runCheck(
      { executable: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(5000))"] },
      { ...opts(), maxOutputBytes: 100 },
    );
    expect(outcome).toMatchObject({ truncated: true });
    expect(outcome.output).toHaveLength(100);
  });

  it('环境变量走白名单，带 CI=1，不继承其他变量', async () => {
    process.env.PALDOCK_SECRET_FOR_TEST = 'leak';
    try {
      const outcome = await runCheck(
        { executable: process.execPath, args: ['-e', 'console.log(JSON.stringify([process.env.CI, process.env.PALDOCK_SECRET_FOR_TEST ?? null]))'] },
        opts(),
      );
      expect(JSON.parse(outcome.output)).toEqual(['1', null]);
    } finally {
      delete process.env.PALDOCK_SECRET_FOR_TEST;
    }
  });

  it.runIf(windows)('Windows .cmd 经 cmd.exe 启动，参数逐个加引号；无法安全转义的字符被拒绝', async () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'paldock-bin-')), 'bin dir');
    mkdirSync(bin, { recursive: true });
    // .cmd 文件按系统代码页读取，脚本路径用纯 ASCII；参数里的中文经命令行（UTF-16）传递
    const asciiScript = join(bin, 'echo-args.js');
    writeFileSync(asciiScript, 'console.log(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(join(bin, 'echoargs.cmd'), `@"${process.execPath}" "${asciiScript}" %*\r\n`);
    const env = { ...childEnv(), PATH: `${bin};${process.env.PATH}` };
    const plan = planSpawn({ executable: 'echoargs', args: ['a b', '&|<>^()'] }, env);
    expect(plan).toMatchObject({ verbatim: true, args: ['/d', '/s', '/c', expect.stringContaining('"a b"')] });

    const outcome = await runCheck({ executable: join(bin, 'echoargs.cmd'), args: ['a b', '中文', '&|<>^()'] }, opts());
    expect(JSON.parse(outcome.output)).toEqual(['a b', '中文', '&|<>^()']);
    for (const bad of ['100%', 'hi!', 'say "x"', 'a\nb']) {
      expect(() => planSpawn({ executable: join(bin, 'echoargs.cmd'), args: [bad] }, env)).toThrow(/无法安全转义/);
    }
  });
});

describe('脱敏', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnop', 'Bearer [已脱敏]'],
    ['key sk-ant-REDACTEDREDACTED1234', '[已脱敏：密钥]'],
    ['ghp_0123456789abcdefghijABCDEFGHIJ', '[已脱敏：令牌]'],
    ['password=hunter2 next', 'password=[已脱敏] next'],
    ['API_KEY: "abc def"', 'API_KEY: [已脱敏]'],
    ['https://user:pass@example.com/x', 'https://[已脱敏]@example.com/x'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----', '[已脱敏：私钥]'],
  ])('%s', (input, expected) => {
    expect(redact(input)).toContain(expected);
  });

  it('普通输出保持不变', () => {
    expect(redact('Tests  12 passed (12)')).toBe('Tests  12 passed (12)');
  });
});

describe('风险分级（只看客观内容）', () => {
  const wt = windows ? 'D:\\data\\worktrees\\abc' : '/data/worktrees/abc';
  const inside = join(wt, 'src', 'a.ts');
  const outside = windows ? 'C:\\Windows\\x' : '/etc/x';

  it('路径判断：大小写不敏感，前缀相同的兄弟目录不算在内', () => {
    expect(isInside(wt, inside)).toBe(true);
    expect(isInside(wt, `${wt}-evil/x`)).toBe(false);
    if (windows) expect(isInside(wt, inside.toUpperCase())).toBe(true);
  });

  it.each([
    [{ kind: 'file_change', paths: [inside] }, 'write_in_worktree'],
    [{ kind: 'file_change', paths: [inside, outside] }, 'write_outside_worktree'],
    [{ kind: 'file_change', paths: [] }, 'write_outside_worktree'],
    [{ kind: 'command', command: 'pnpm install', cwd: wt }, 'install_dependencies'],
    [{ kind: 'command', command: 'pnpm test', cwd: wt }, 'run_command_in_worktree'],
    // 真实 Codex 实测：越界写文件的命令，路径里带 tests 也不能被当成跑测试
    [{ kind: 'command', command: `Set-Content -Path '${join(outside, 'tests', 'x.txt')}' -Value hi`, cwd: wt }, 'write_outside_worktree'],
    [{ kind: 'command', command: `type "${inside}"`, cwd: wt }, 'run_command_in_worktree'],
    // 网址、cmd 开关、开头的程序路径不算越界；.. 跳出算越界
    [{ kind: 'command', command: 'curl https://registry.npmjs.org/x', cwd: wt }, 'run_command_in_worktree'],
    [{ kind: 'command', command: 'cmd /c pnpm install', cwd: wt }, 'install_dependencies'],
    [{ kind: 'command', command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command npm ci', cwd: wt }, 'install_dependencies'],
    [{ kind: 'command', command: 'Remove-Item -Recurse ..\\..\\other-repo', cwd: wt }, 'write_outside_worktree'],
    [{ kind: 'command', command: 'rm -rf ../x', cwd: wt }, 'write_outside_worktree'],
    [{ kind: 'command', command: 'git push origin main', cwd: wt }, 'push_remote'],
    [{ kind: 'command', command: 'ls', cwd: outside }, 'write_outside_worktree'],
    [{ kind: 'command', command: 'curl example.com', cwd: wt }, 'run_command_in_worktree'],
    [{ kind: 'permissions' }, 'expand_permissions'],
  ] as const)('%j → %s', (request, expected) => {
    expect(operationOf({ nativeRequestId: '1', summary: '', ...request } as never, wt)).toBe(expected);
  });
});

it('任务标题取目标第一行', () => {
  expect(titleOf('  修复登录\n细节……')).toBe('修复登录');
  expect(titleOf('x'.repeat(100))).toHaveLength(60);
});
