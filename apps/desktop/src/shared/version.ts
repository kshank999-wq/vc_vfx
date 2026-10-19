/** Compare dotted versions numerically (`0.10.0` > `0.9.3`); a pre-release suffix sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().replace(/^v/i, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  const length = Math.max(x.parts.length, y.parts.length);
  for (let i = 0; i < length; i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export const isNewer = (candidate: string, current: string): boolean => compareVersions(candidate, current) > 0;
