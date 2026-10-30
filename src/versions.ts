/**
 * Toolchain requirements per Angular major.
 * Source: https://angular.dev/reference/versions (and the v6–v12 archived docs).
 * Entries marked `verify` were not final when this table was written —
 * confirm them on angular.dev before relying on them.
 */
export interface AngularRequirements {
  node: string;
  typescript: string;
  rxjs: string;
  zone: string;
  verify?: boolean;
}

export const REQUIREMENTS: Record<number, AngularRequirements> = {
  6: { node: '^8.9.0 || ^10.9.0', typescript: '>=2.7.2 <2.10.0', rxjs: '^6.0.0', zone: '~0.8.26' },
  7: { node: '^8.9.0 || ^10.9.0', typescript: '>=3.1.1 <3.3.0', rxjs: '^6.3.0', zone: '~0.8.26' },
  8: { node: '^10.9.0 || ^12.0.0', typescript: '>=3.4.0 <3.6.0', rxjs: '^6.4.0', zone: '~0.9.1' },
  9: { node: '^10.13.0 || ^12.11.0', typescript: '>=3.6.4 <3.9.0', rxjs: '^6.5.3', zone: '~0.10.2' },
  10: { node: '^10.13.0 || ^12.11.0', typescript: '>=3.9.0 <4.1.0', rxjs: '^6.5.3', zone: '~0.10.3' },
  11: { node: '^10.13.0 || ^12.11.0', typescript: '>=4.0.0 <4.2.0', rxjs: '^6.5.3', zone: '~0.11.3' },
  12: { node: '^12.14.0 || ^14.15.0', typescript: '>=4.2.3 <4.4.0', rxjs: '^6.5.3 || ^7.0.0', zone: '~0.11.4' },
  13: { node: '^12.20.0 || ^14.15.0 || ^16.10.0', typescript: '>=4.4.2 <4.6.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.11.4' },
  14: { node: '^14.15.0 || ^16.10.0', typescript: '>=4.6.2 <4.9.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.11.4' },
  15: { node: '^14.20.0 || ^16.13.0 || ^18.10.0', typescript: '>=4.8.2 <5.0.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.11.4 || ~0.12.0' },
  16: { node: '^16.14.0 || ^18.10.0', typescript: '>=4.9.3 <5.2.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.13.0' },
  17: { node: '^18.13.0 || ^20.9.0', typescript: '>=5.2.0 <5.5.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.14.0' },
  18: { node: '^18.19.1 || ^20.11.1 || ^22.0.0', typescript: '>=5.4.0 <5.6.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.14.0' },
  19: { node: '^18.19.1 || ^20.11.1 || ^22.0.0', typescript: '>=5.5.0 <5.9.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.15.0' },
  20: { node: '^20.19.0 || ^22.12.0 || ^24.0.0', typescript: '>=5.8.0 <5.9.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.15.0' },
  21: { node: '^20.19.0 || ^22.12.0 || ^24.0.0', typescript: '>=5.9.0 <6.0.0', rxjs: '^6.5.3 || ^7.4.0', zone: '~0.15.0' },
  22: { node: '^22.12.0 || ^24.0.0', typescript: '>=5.9.0 <6.1.0', rxjs: '^7.4.0', zone: '~0.15.0', verify: true },
};

export const MIN_VERSION = 6;
export const MAX_VERSION = 22;

export function requirementsFor(major: number): AngularRequirements | undefined {
  return REQUIREMENTS[major];
}

/** A version that satisfies a range like "^8.9.0 || ^10.9.0" — the highest listed lower bound. */
export function recommendedFromRange(range: string): string {
  const bounds = range.split('||').map((r) => r.trim().replace(/^[\^~>=<\s]+/, '').split(/\s/)[0]);
  return bounds[bounds.length - 1];
}
