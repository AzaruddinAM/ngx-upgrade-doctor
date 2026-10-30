import { Project } from './project';
import { RULES, Finding, Rule, RuleContext, Severity, isApplicable, severityAt } from './rules';

export interface RunOptions {
  project: Project;
  mode: 'target' | 'current';
  /** Target major (mode "target"); ignored in mode "current". */
  target?: number;
  /** Restrict to these rule ids. */
  only?: string[];
  rules?: Rule[];
}

export interface RuleResult {
  rule: Rule;
  severity: Severity;
  findings: Finding[];
}

export interface FixResult {
  applied: string[];
  /** Rules whose fix needs a newer installed Angular — run `current --fix` after `ng update`. */
  deferred: Array<{ rule: Rule; requires: number }>;
  changedFiles: string[];
}

const RANK: Record<Severity, number> = { error: 2, warning: 1, info: 0 };

export function contextFor(opts: RunOptions): RuleContext {
  const currentVersion = opts.project.angularMajor;
  if (currentVersion === undefined) {
    throw new Error('Could not find @angular/core in package.json — is this an Angular workspace?');
  }
  const version = opts.mode === 'target' ? opts.target! : currentVersion;
  return { project: opts.project, version, currentVersion, mode: opts.mode };
}

export function scan(opts: RunOptions): RuleResult[] {
  const ctx = contextFor(opts);
  const results: RuleResult[] = [];
  for (const rule of opts.rules || RULES) {
    if (opts.only && !opts.only.includes(rule.id)) continue;
    if (!isApplicable(rule, ctx.version)) continue;
    const severity = severityAt(rule, ctx.version);
    let raw;
    try {
      raw = rule.check(ctx);
    } catch (e) {
      raw = [{ message: `Rule crashed: ${(e as Error).message}` }];
    }
    if (!raw.length) continue;
    const findings = raw.map((f) => ({ ...f, ruleId: rule.id, severity, fixable: !!rule.fix }));
    results.push({ rule, severity, findings });
  }
  return results.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

/**
 * Applies auto-fixes for warnings and errors. In target mode a fix that only
 * compiles on a newer Angular is deferred until after `ng update`.
 */
export function fix(opts: RunOptions & { dryRun?: boolean }): FixResult {
  const ctx = contextFor(opts);
  const result: FixResult = { applied: [], deferred: [], changedFiles: [] };
  for (const { rule, severity } of scan(opts)) {
    if (!rule.fix || severity === 'info') continue;
    const requires = rule.fixRequires || 0;
    if (ctx.currentVersion < requires) {
      result.deferred.push({ rule, requires });
      continue;
    }
    rule.fix(ctx);
    result.applied.push(rule.id);
  }
  result.changedFiles = opts.project.flush(!!opts.dryRun);
  return result;
}

export function summarize(results: RuleResult[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const r of results) out[r.severity] += r.findings.length;
  return out;
}
