import { describe, expect, it } from 'vitest';
import { isPlainConfirmation, isSensitivePath, notAConsent, routeRead } from './read-access.js';

const HOME = String.raw`C:\Users\me`;

describe('项目外只读的分层', () => {
  it('敏感路径：家目录下的凭据 / 密钥 / 浏览器配置 / 执行器配置，任何位置的 .env*、*.pem、*.key、私钥', () => {
    for (const p of [
      String.raw`C:\Users\me\.ssh\id_ed25519`,
      'c:/users/me/.aws/credentials',
      String.raw`C:\Users\me\.codex\auth.json`,
      String.raw`C:\Users\me\.claude\settings.json`,
      String.raw`C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Cookies`,
      String.raw`D:\proj\.env`,
      String.raw`D:\proj\.env.local`,
      String.raw`D:\certs\server.pem`,
      String.raw`D:\certs\server.key`,
      String.raw`E:\backup\id_rsa`,
      String.raw`D:\software\PalDock\data\paldock.db`,
    ])
      expect(isSensitivePath(p, HOME, [String.raw`D:\software\PalDock\data`]), p).toBe(true);
    for (const p of [String.raw`C:\Users\me\AppData\Local\Temp\snake\2_menu_color.png`, String.raw`D:\assets\login-before.png`, String.raw`C:\Users\me\.sshx\a`, String.raw`D:\proj\environment.ts`])
      expect(isSensitivePath(p, HOME), p).toBe(false);
  });

  it('分层：项目里 → inside；有敏感路径 → sensitive；都是这一轮生成的 → own_output；协调助手能判断 → coordinator；其余 → user', () => {
    const base = { inside: (p: string) => p.startsWith('D:/proj'), sensitive: (p: string) => p.endsWith('.env'), createdThisRun: (p: string) => p.includes('/tmp/run'), coordinatorAvailable: true };
    expect(routeRead({ ...base, paths: ['D:/proj/a.ts'] })).toBe('inside');
    expect(routeRead({ ...base, paths: ['D:/x/.env', 'D:/tmp/run/a.png'] })).toBe('sensitive');
    // 敏感优先于「这一轮生成的」
    expect(routeRead({ ...base, paths: ['D:/tmp/run/.env'] })).toBe('sensitive');
    expect(routeRead({ ...base, paths: ['D:/tmp/run/a.png', 'D:/proj/b.ts'] })).toBe('own_output');
    expect(routeRead({ ...base, paths: ['D:/tmp/run/a.png', 'D:/assets/b.png'] })).toBe('coordinator');
    expect(routeRead({ ...base, coordinatorAvailable: false, paths: ['D:/assets/b.png'] })).toBe('user');
    expect(routeRead({ ...base, paths: [] })).toBe('user');
  });

  it('一句话算不算同意（宿主兜底）：提问、带否定或还没决定的不算；明确的决定（含部分批准）算', () => {
    for (const t of ['我还没说可以', '为什么要我点允许？', '可以吗?', '是不是都要读', '先别放行', '等等，我看一下'])
      expect(notAConsent(t), t).toBeDefined();
    for (const t of ['可以', '第一张可以', '第一张可以，第二张不用', '好，推吧', '都不要']) expect(notAConsent(t), t).toBeUndefined();
  });

  it('明确、无条件的确认（选择性提交只认这种）：整条回复去掉标点空白后完全匹配', () => {
    for (const t of ['可以', '可以。', ' 确认提交！', '好的', 'OK', 'yes', '按刚才的选择提交']) expect(isPlainConfirmation(t), t).toBe(true);
    for (const t of ['可以，提交第二块', '可以吧但先别推', '提交第一块', '确认，不过只要 a.txt', '好像可以']) expect(isPlainConfirmation(t), t).toBe(false);
  });
});
