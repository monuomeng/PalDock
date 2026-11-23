/**
 * 检查命令输出等可能含凭据的文本，在落盘前按常见格式脱敏。
 * 这是尽力而为的兜底，不能替代「不把凭据交给子进程」（环境变量白名单）。
 */
const PATTERNS: readonly [RegExp, string][] = [
  // PEM 私钥块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已脱敏：私钥]'],
  // Authorization: Bearer xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [已脱敏]'],
  // 常见前缀的密钥：OpenAI / Anthropic、GitHub、Slack、AWS、Google
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})/g, '[已脱敏：密钥]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[已脱敏：令牌]'],
  [/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, '[已脱敏：令牌]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[已脱敏：密钥]'],
  [/\b(AIza[0-9A-Za-z_-]{30,})/g, '[已脱敏：密钥]'],
  // key=value / key: value 形式的口令与令牌
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi, '$1$2[已脱敏]'],
  // URL 里的用户名:密码
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[已脱敏]@'],
];

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
