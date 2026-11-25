/** 比较 major.minor.patch，忽略预发布后缀；解析不了的版本视为不满足。 */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const [have, need] = [parse(version), parse(minimum)];
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}
