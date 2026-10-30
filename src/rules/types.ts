import { Project } from '../project';

export type Severity = 'error' | 'warning' | 'info';

export interface RuleContext {
  project: Project;
  /** The Angular major being evaluated: the target in `scan/fix`, the installed one in `current`. */
  version: number;
  /** The installed Angular major. */
  currentVersion: number;
  mode: 'target' | 'current';
}

export interface RawFinding {
  message: string;
  file?: string;
  line?: number;
}

export interface Finding extends RawFinding {
  ruleId: string;
  severity: Severity;
  fixable: boolean;
}

export interface Rule {
  id: string;
  /** Which upgrade hop this rule belongs to, e.g. "v11-12". */
  hop: string;
  title: string;
  /** First Angular major at which this rule is relevant. */
  since: number;
  /** Last Angular major at which this rule is relevant (inclusive). */
  until?: number;
  /** From this major the finding is a warning (deprecated). */
  deprecatedIn?: number;
  /** From this major the finding is an error (removed / build breaks). */
  removedIn?: number;
  /** Severity before `deprecatedIn`; defaults to "info". */
  level?: Severity;
  /** How to fix it by hand, or which official schematic to run. */
  hint?: string;
  docs?: string;
  /** The auto-fix only compiles once the installed Angular major is at least this. */
  fixRequires?: number;
  check(ctx: RuleContext): RawFinding[];
  /** Rewrites files in `ctx.project` (in memory). */
  fix?(ctx: RuleContext): void;
}

export function severityAt(rule: Rule, version: number): Severity {
  if (rule.removedIn !== undefined && version >= rule.removedIn) return 'error';
  if (rule.deprecatedIn !== undefined && version >= rule.deprecatedIn) return 'warning';
  return rule.level || 'info';
}

export function isApplicable(rule: Rule, version: number): boolean {
  return version >= rule.since && (rule.until === undefined || version <= rule.until);
}
