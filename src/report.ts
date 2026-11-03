import { RuleResult, summarize } from './engine';
import { DepAdvice } from './deps';
import { Severity } from './rules';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  red: paint(31), yellow: paint(33), cyan: paint(36), green: paint(32), gray: paint(90), bold: paint(1),
};

const ICON: Record<Severity, string> = { error: c.red('✖'), warning: c.yellow('⚠'), info: c.cyan('ℹ') };
const LABEL: Record<Severity, string> = { error: c.red('BLOCKER'), warning: c.yellow('WARNING'), info: c.cyan('SUGGEST') };

export function printFindings(results: RuleResult[], verbose: boolean): void {
  for (const { rule, severity, findings } of results) {
    const fixable = findings.some((f) => f.fixable) ? c.green(' [auto-fix]') : '';
    console.log(`\n${ICON[severity]} ${LABEL[severity]} ${c.bold(rule.title)} ${c.gray(`(${rule.id}, ${rule.hop})`)}${fixable}`);
    const shown = verbose ? findings : findings.slice(0, 8);
    for (const f of shown) {
      const loc = f.file ? c.gray(`${f.file}${f.line ? `:${f.line}` : ''}`) + '  ' : '';
      console.log(`    ${loc}${f.message}`);
    }
    if (findings.length > shown.length) console.log(c.gray(`    … and ${findings.length - shown.length} more (use --verbose)`));
    if (rule.hint) console.log(`    ${c.cyan('→')} ${rule.hint}`);
    if (rule.docs) console.log(`    ${c.gray(rule.docs)}`);
  }
}

export function printSummary(results: RuleResult[]): void {
  const s = summarize(results);
  const fixable = results.filter((r) => r.severity !== 'info').reduce((n, r) => n + r.findings.filter((f) => f.fixable).length, 0);
  console.log(`\n${c.bold('Summary:')} ${c.red(`${s.error} blocker(s)`)}, ${c.yellow(`${s.warning} warning(s)`)}, ${c.cyan(`${s.info} suggestion(s)`)}; ${c.green(`${fixable} auto-fixable`)}`);
}

export function printDeps(advice: DepAdvice[]): void {
  const rows = advice.map((a) => [a.name, a.current, actionLabel(a.action), a.suggested || '', a.note]);
  const header = ['package', 'current', 'action', 'suggested', 'note'];
  const widths = header.map((h, i) => Math.min(40, Math.max(h.length, ...rows.map((r) => stripAnsi(r[i]).length))));
  const fmt = (r: string[]) => r.map((cell, i) => (i < 4 ? pad(cell, widths[i]) : cell)).join('  ');
  console.log(c.bold(fmt(header)));
  for (const r of rows) console.log(fmt(r));
}

function actionLabel(a: string): string {
  switch (a) {
    case 'ok': return c.green('ok');
    case 'upgrade': return c.yellow('upgrade');
    case 'remove': return c.red('remove');
    case 'replace': return c.red('replace');
    case 'ng-update': return c.cyan('ng update');
    default: return c.gray(a);
  }
}

function pad(s: string, w: number): string {
  const len = stripAnsi(s).length;
  return len >= w ? s : s + ' '.repeat(w - len);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[\d+m/g, '');
}
