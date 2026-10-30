#!/usr/bin/env node
import * as readline from 'readline';
import { Project } from './project';
import { RuleResult, fix, scan, summarize } from './engine';
import { GitDependency, adviseDeps, applyDepCommands, gitDependencies, otherPackageManager, planDepCommands } from './deps';
import { RULES, severityAt } from './rules';
import { c, printDeps, printFindings, printSummary } from './report';
import { compileDiagnostics } from './tsc';
import { TypeMode, applyTypePlan, collectUntyped, planTypes } from './typer';
import { MAX_VERSION, MIN_VERSION, requirementsFor, recommendedFromRange } from './versions';

const HELP = `
${c.bold('ngx-upgrade-doctor')} — upgrade Angular one major at a time, with fewer surprises.

${c.bold('Usage')}
  ngx-upgrade-doctor <command> [options]

${c.bold('Commands')}
  scan --target <N>     Report what blocks the upgrade to Angular N (run BEFORE ng update)
  fix  --target <N>     Apply the safe auto-fixes for Angular N (run BEFORE ng update)
  current               Report warnings/errors for the installed version — no upgrade
         --fix          Apply auto-fixes for those
         --tsc          Also compile with tsc and include its errors
         --all          Include suggestions (info), not only warnings/errors
  deps --target <N>     Suggest dependency versions for Angular N
         --online       Resolve versions from the npm registry using peerDependencies
         --latest       With --online: newest compatible release instead of the smallest upgrade
         --apply        Run the commands: ng update, npm uninstall, npm install --save / --save-dev
         --yes          With --apply: do not ask first     --dry-run  With --apply: print only
         --allow-dirty  Pass --allow-dirty to ng update    --ng-force  Pass --force to ng update
         --legacy-peer-deps  Use npm legacy peer resolution for every command
  plan [--target 22]    Print the hop-by-hop plan from the installed version
  types                 Add explicit types to variables, parameters, properties and return types (v22+)
         --mode <m>     infer (default) | any | implicit-any
         --yes          Apply without asking     --no-specs   Skip *.spec.ts
         --skip-callbacks  Leave arr.map(x => ...) style callbacks alone
         --force        Run on versions below 22
  rules                 List every rule

${c.bold('Options')}
  --project <dir>   Workspace root (default: current directory)
  --dry-run         Show what would change without writing
  --json            Machine-readable output (scan, current, deps)
  --verbose         Show every finding

${c.bold('Workflow per hop')}
  ngx-upgrade-doctor scan --target 8
  ngx-upgrade-doctor fix --target 8
  npx ng update @angular/core@8 @angular/cli@8
  ngx-upgrade-doctor current --fix --tsc
  ng build && ng test --watch=false && git commit -am "Angular 8"
`;

interface Flags {
  [k: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command?: string; flags: Flags } {
  const flags: Flags = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (key.startsWith('no-')) flags[key.slice(3)] = false;
      else if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['target', 'project', 'mode', 'registry', 'only'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (a === '-h') {
      flags.help = true;
    } else if (!command) {
      command = a;
    }
  }
  return { command, flags };
}

function targetFrom(flags: Flags, current: number, fallback?: number): number {
  const raw = flags.target;
  const target = raw === undefined || raw === true ? fallback : parseInt(String(raw), 10);
  if (target === undefined || isNaN(target)) throw new Error('Missing --target <major>, e.g. --target 8');
  if (target < MIN_VERSION || target > MAX_VERSION) throw new Error(`--target must be between ${MIN_VERSION} and ${MAX_VERSION}`);
  return target;
}

function header(project: Project, label: string): void {
  const node = process.versions.node;
  console.log(`${c.bold('ngx-upgrade-doctor')} ${c.gray('·')} ${project.pkg.name || project.root} ${c.gray('·')} Angular ${project.angularMajor} ${c.gray('·')} Node ${node}`);
  console.log(c.gray(label));
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => {
    rl.close();
    resolve(a.trim());
  }));
}

const interactive = (flags: Flags) => !!process.stdin.isTTY && !flags.yes && !flags.json;

// ---------------------------------------------------------------------------

async function cmdScan(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const target = targetFrom(flags, current, Math.min(current + 1, MAX_VERSION));
  const results = scan({ project, mode: 'target', target, only: onlyFlag(flags) });

  if (target > current + 1) {
    results.unshift(metaResult('core/one-hop-at-a-time', 'Angular does not support skipping majors', 'error',
      `Installed ${current}, target ${target}. Update ${current} → ${current + 1} first; scan each hop.`,
      `Run \`ngx-upgrade-doctor plan --target ${target}\` for the full sequence.`));
  }

  if (flags.json) {
    console.log(JSON.stringify({ current, target, summary: summarize(results), results: results.map(toJson) }, null, 2));
  } else {
    header(project, `Pre-upgrade scan: Angular ${current} → ${target}`);
    if (target <= current) console.log(c.yellow(`Target ${target} is not above the installed version — use \`current\` to check this version.`));
    printFindings(results, !!flags.verbose);
    printSummary(results);
    console.log(`\nNext: ${c.cyan(`ngx-upgrade-doctor fix --target ${target}`)}, then ${c.cyan(`ngx-upgrade-doctor deps --target ${target}`)}`);
  }
  return results.some((r) => r.severity === 'error') ? 1 : 0;
}

async function cmdFix(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const target = targetFrom(flags, current, Math.min(current + 1, MAX_VERSION));
  header(project, `Auto-fix for Angular ${target}${flags['dry-run'] ? ' (dry run)' : ''}`);
  const res = fix({ project, mode: 'target', target, dryRun: !!flags['dry-run'], only: onlyFlag(flags) });
  printFixResult(res.applied, res.changedFiles, !!flags['dry-run']);
  if (res.deferred.length) {
    console.log(`\n${c.yellow('Deferred')} — these fixes need the newer Angular installed. After ng update, run ${c.cyan('ngx-upgrade-doctor current --fix')}:`);
    for (const d of res.deferred) console.log(`  • ${d.rule.id} (needs Angular ${d.requires})`);
  }
  const remaining = scan({ project, mode: 'target', target }).filter((r) => r.severity !== 'info');
  if (remaining.length) {
    console.log(`\n${c.bold('Still needs a human:')}`);
    printFindings(remaining.filter((r) => !r.rule.fix || res.deferred.some((d) => d.rule === r.rule)), !!flags.verbose);
  }
  console.log(`\nNext: ${c.cyan(ngUpdateCommand(project, target))}`);
  if (target >= 22) await offerTypes(project, flags);
  return 0;
}

async function cmdCurrent(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const filter = (rs: RuleResult[]) => (flags.all ? rs : rs.filter((r) => r.severity !== 'info'));
  if (flags.fix) {
    header(project, `Fixing current-version issues (Angular ${current})${flags['dry-run'] ? ' (dry run)' : ''}`);
    const res = fix({ project, mode: 'current', dryRun: !!flags['dry-run'], only: onlyFlag(flags) });
    printFixResult(res.applied, res.changedFiles, !!flags['dry-run']);
  }
  const results = filter(scan({ project, mode: 'current', only: onlyFlag(flags) }));
  if (flags.tsc) {
    const diags = compileDiagnostics(project);
    if (diags) results.unshift(diags);
  }
  if (flags.json) {
    console.log(JSON.stringify({ current, summary: summarize(results), results: results.map(toJson) }, null, 2));
  } else {
    if (!flags.fix) header(project, `Current-version check (Angular ${current}) — no upgrade`);
    printFindings(results, !!flags.verbose);
    printSummary(results);
    if (!flags.fix && results.some((r) => r.rule.fix)) console.log(`\nApply fixes: ${c.cyan('ngx-upgrade-doctor current --fix')}`);
    if (!flags.all) console.log(c.gray('Suggestions are hidden; add --all to see them.'));
  }
  if (current >= 22) await offerTypes(project, flags);
  return results.some((r) => r.severity === 'error') ? 1 : 0;
}

async function cmdDeps(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const target = targetFrom(flags, current, Math.min(current + 1, MAX_VERSION));
  if (!flags.json) {
    header(project, `Dependency advice for Angular ${target}${flags.online ? ' (npm registry)' : ' (offline — add --online for registry-verified versions)'}`);
  }
  const advice = await adviseDeps({ project, target, online: !!flags.online, latest: !!flags.latest, registry: flags.registry as string | undefined });
  const steps = planDepCommands(advice, project, target, { allowDirty: !!flags['allow-dirty'], ngForce: !!flags['ng-force'] });
  const commands = steps.filter((s) => s.step !== 'manual').map((s) => s.command);
  const gitDeps = gitDependencies(project);
  if (flags.json) {
    console.log(JSON.stringify({ current, target, advice, commands, steps, gitDependencies: gitDeps }, null, 2));
    return 0;
  }
  console.log('');
  printDeps(advice);
  console.log(`\n${c.bold('Commands')} (in order):`);
  for (const s of steps.filter((x) => x.step !== 'manual')) console.log(`  ${c.gray(pad(STEP_LABEL[s.step], 18))} ${c.cyan(s.command)}`);
  const manual = steps.filter((s) => s.step === 'manual');
  if (manual.length) {
    console.log(`\n${c.bold('By hand')} (not automated):`);
    for (const s of manual) console.log(`  • ${s.command}`);
  }
  if (gitDeps.length) printGitDeps(gitDeps);
  if (target > current + 1) {
    console.log(c.yellow(`\nNote: you are on ${current}; go through each major up to ${target}.`));
    if (flags.apply) {
      console.log(c.red('Not applying: --apply only runs one hop at a time. Use --target ' + (current + 1) + '.'));
      return 1;
    }
  }

  if (!flags.apply) {
    console.log(`\nRun them automatically: ${c.cyan(`ngx-upgrade-doctor deps --target ${target}${flags.online ? ' --online' : ''} --apply`)}`);
    return 0;
  }
  const pm = otherPackageManager(project);
  if (pm) {
    console.log(c.red(`\nNot applying: this project uses ${pm}, and --apply drives npm. Run the commands above with ${pm} instead.`));
    return 1;
  }
  if (flags['dry-run']) {
    console.log(c.gray('\nDry run — nothing was run.'));
    return 0;
  }
  if (!flags.yes) {
    if (!interactive(flags)) {
      console.log(`\nRe-run with ${c.cyan('--yes')} to run these commands.`);
      return 0;
    }
    console.log(c.gray('\nTip: commit first — ng update refuses to run on uncommitted changes unless you pass --allow-dirty.'));
    const a = await ask('Run these commands now? (y/N) ');
    if (!/^y(es)?$/i.test(a)) {
      console.log('Nothing was run.');
      return 0;
    }
  }
  const res = applyDepCommands(steps, project, { legacyPeerDeps: !!flags['legacy-peer-deps'] });
  if (res.failed) {
    console.log(c.red(`\nStopped: "${res.failed.command}" exited with code ${res.failed.code}.`));
    console.log('Fix the error above and re-run; commands that already ran are safe to repeat.');
    if (!flags['legacy-peer-deps']) console.log(`Peer dependency conflicts? Try ${c.cyan('--legacy-peer-deps')} (safer than npm --force), or ${c.cyan('--ng-force')} for ng update.`);
    if (gitDeps.length) console.log(`"git dep preparation failed" or "pickAlgorithm"? Run ${c.cyan('npm cache clean --force')} and re-run — see the git dependencies listed above.`);
    return 1;
  }
  console.log(c.green(`\nDone: ran ${res.ran.length} command(s).`));
  console.log(`Next: ${c.cyan('ngx-upgrade-doctor current --fix --tsc')}, then ng build and ng test.`);
  return 0;
}

function printGitDeps(gitDeps: GitDependency[]): void {
  console.log(`\n${c.yellow('⚠ Installed from git or a URL, not the npm registry')} — npm 8 (Node 16/18) often fails on these with`);
  console.log(`  "git dep preparation failed" or "Cannot read properties of null (reading 'pickAlgorithm')":`);
  for (const g of gitDeps) console.log(`  • ${g.name} ${c.gray(g.spec)}${g.direct ? '' : c.gray(' (pulled in by another package)')}`);
  console.log(`  If an install fails: ${c.cyan('npm cache clean --force')}, then retry. Still failing: delete node_modules and package-lock.json, then ${c.cyan('npm install --legacy-peer-deps')}.`);
  console.log('  Better: replace each one with a published npm version.');
}

const STEP_LABEL: Record<string, string> = {
  'ng-update': 'ng update',
  uninstall: 'remove',
  'install-save': 'dependencies',
  'install-save-dev': 'devDependencies',
};

const HOP_NOTES: Record<number, string> = {
  7: 'Mostly painless. Check rxjs 6 imports and the CLI budgets.',
  8: 'Differential loading, dynamic-import lazy routes, @ViewChild static flag, @angular/http removed.',
  9: 'Ivy becomes the default. entryComponents not needed, TestBed.inject, Renderer removed.',
  10: 'ModuleWithProviders<T> required; stricter TS settings offered.',
  11: 'async → waitForAsync; TSLint deprecated.',
  12: 'node-sass dropped, Material @use theming, ESLint migration, IE11 deprecated.',
  13: 'View Engine removed — libraries must be Ivy. IE11 dropped. Sass ~ imports.',
  14: 'Typed forms (UntypedFormGroup), standalone preview, Node 14+.',
  15: 'Material switches to MDC (legacy imports added); standalone stable; functional guards.',
  16: 'ngcc removed; signals preview; Node 16/18.',
  17: 'Legacy Material removed; control flow, deferrable views; application builder.',
  18: 'HttpClientModule deprecated; zoneless preview.',
  19: 'Standalone by default; ng update adds standalone: false to NgModule components.',
  20: 'Structural directives deprecated; Node 20.19+.',
  21: 'Zoneless and Vitest defaults for new apps; @angular/animations deprecated.',
  22: 'Check release notes; then run `ngx-upgrade-doctor types` for explicit typing.',
};

async function cmdPlan(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const target = targetFrom(flags, current, MAX_VERSION);
  header(project, `Upgrade plan: Angular ${current} → ${target}`);
  if (target <= current) {
    console.log('Nothing to do — already there.');
    return 0;
  }
  for (let v = current + 1; v <= target; v++) {
    const req = requirementsFor(v);
    console.log(`\n${c.bold(`── Angular ${v} ──`)} ${c.gray(HOP_NOTES[v] || '')}`);
    if (req) console.log(c.gray(`   Node ${recommendedFromRange(req.node)}+ (${req.node}) · TypeScript ${req.typescript}${req.verify ? ' · verify on angular.dev' : ''}`));
    console.log(`   1. ngx-upgrade-doctor scan --target ${v}`);
    console.log(`   2. ngx-upgrade-doctor fix --target ${v}`);
    console.log(`   3. ngx-upgrade-doctor deps --target ${v} --online`);
    console.log(`   4. ${ngUpdateCommand(project, v)}`);
    console.log(`   5. ngx-upgrade-doctor current --fix --tsc`);
    console.log(`   6. ng build && ng test --watch=false && git commit -am "chore: Angular ${v}"`);
    console.log(c.gray(`      Checklist: https://angular.dev/update-guide?v=${v - 1}.0-${v}.0&l=3`));
  }
  return 0;
}

async function cmdTypes(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  if (current < 22 && !flags.force) {
    console.log(c.yellow(`The types pass is meant for Angular 22+ (installed: ${current}). Re-run with --force to use it anyway.`));
    return 1;
  }
  let mode = flags.mode as TypeMode | undefined;
  if (mode && !['infer', 'any', 'implicit-any'].includes(mode)) throw new Error('--mode must be infer, any or implicit-any');
  if (!mode && interactive(flags)) {
    console.log('How should types be added?');
    console.log(`  1) infer         ${c.gray('the type TypeScript infers (e.g. string, Observable<User>), any when it cannot be named — recommended')}`);
    console.log(`  2) any           ${c.gray('`: any` on every parameter, variable, property and return type')}`);
    console.log(`  3) implicit-any  ${c.gray('`: any` only where noImplicitAny reports an error')}`);
    const a = await ask('Choose 1-3 [1]: ');
    mode = a === '2' ? 'any' : a === '3' ? 'implicit-any' : 'infer';
  }
  mode = mode || 'infer';

  console.log(c.gray(`Analysing with mode "${mode}" (type-checking the workspace)…`));
  const plan = planTypes(project, { mode, includeSpecs: flags.specs !== false, skipCallbacks: !!flags['skip-callbacks'] });
  const total = plan.annotations.length;
  if (!total && !plan.reverted.length) {
    console.log(c.green('Every declaration already has an explicit type.'));
    return 0;
  }
  const byKind: Record<string, number> = {};
  for (const a of plan.annotations) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  const anyCount = plan.annotations.filter((a) => /^any(\[\])?$/.test(a.type)).length;
  console.log(`\n${c.bold(`${total} annotation(s) in ${plan.output.size} file(s)`)}: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}${mode === 'infer' ? ` — ${anyCount} fell back to any` : ''}`);
  const sample = flags.verbose ? plan.annotations : plan.annotations.slice(0, 15);
  for (const a of sample) console.log(`  ${c.gray(`${a.file}:${a.line}`)}  ${a.kind} ${c.bold(a.name)}: ${c.cyan(a.type)}`);
  if (total > sample.length) console.log(c.gray(`  … and ${total - sample.length} more (use --verbose)`));
  if (plan.skipped) {
    console.log(c.gray(`\nLeft ${plan.skipped} declaration(s) to inference: their exact type cannot be written in that file, and \`any\` would lose type safety.`));
  }
  if (plan.reverted.length) {
    console.log(c.yellow(`\nSkipped ${plan.reverted.length} file(s) where the annotations would add compiler errors:`));
    for (const f of plan.reverted) console.log(`  ${f}`);
  }

  if (flags['dry-run'] || !total) return 0;
  if (!flags.yes) {
    if (!interactive(flags)) {
      console.log(`\nRe-run with ${c.cyan('--yes')} to apply.`);
      return 0;
    }
    const a = await ask(`\nAdd these types? (y/N) `);
    if (!/^y(es)?$/i.test(a)) {
      console.log('No changes made.');
      return 0;
    }
  }
  applyTypePlan(project, plan);
  const written = project.flush(false);
  console.log(c.green(`\nUpdated ${written.length} file(s).`));
  console.log(`Next: enable ${c.cyan('"noImplicitAny": true')} (or ${c.cyan('"strict": true')}) in tsconfig.json so new code stays typed, then ng build.`);
  return 0;
}

async function offerTypes(project: Project, flags: Flags): Promise<void> {
  if (flags.json) return;
  const untyped = collectUntyped(project).reduce((n, f) => n + f.count, 0);
  if (!untyped) return;
  console.log(`\n${c.cyan('ℹ')} Angular 22+: ${untyped} declaration(s) have no explicit type.`);
  if (!interactive(flags)) {
    console.log(`   Run ${c.cyan('ngx-upgrade-doctor types')} to add them.`);
    return;
  }
  const a = await ask('   Add explicit types now? (y/N) ');
  if (/^y(es)?$/i.test(a)) await cmdTypes(project, { ...flags, mode: undefined });
}

function cmdRules(): number {
  for (const r of RULES) {
    const range = `${r.since}${r.until ? `-${r.until}` : '+'}`;
    const sev = r.removedIn ? `error ≥${r.removedIn}` : r.deprecatedIn ? `warn ≥${r.deprecatedIn}` : severityAt(r, r.since);
    console.log(`${pad(r.id, 40)} ${pad(r.hop, 11)} ${pad(`v${range}`, 7)} ${pad(sev, 11)} ${r.fix ? c.green('auto-fix') : '        '}  ${r.title}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------

function ngUpdateCommand(project: Project, v: number): string {
  const deps = project.declaredDeps;
  const pkgs = [`@angular/core@${v}`, `@angular/cli@${v}`];
  if (deps['@angular/material']) pkgs.push(`@angular/material@${v}`);
  else if (deps['@angular/cdk']) pkgs.push(`@angular/cdk@${v}`);
  return `npx ng update ${pkgs.join(' ')}`;
}

function printFixResult(applied: string[], changed: string[], dryRun: boolean): void {
  if (!applied.length) {
    console.log('\nNothing to auto-fix.');
    return;
  }
  console.log(`\n${c.green(dryRun ? 'Would apply' : 'Applied')}: ${applied.join(', ')}`);
  console.log(`${dryRun ? 'Would change' : 'Changed'} ${changed.length} file(s):`);
  for (const f of changed) console.log(`  ${f}`);
}

function metaResult(id: string, title: string, severity: 'error', message: string, hint: string): RuleResult {
  return {
    rule: { id, hop: 'every hop', title, since: 0, hint, check: () => [] },
    severity,
    findings: [{ ruleId: id, severity, message, fixable: false }],
  };
}

function toJson(r: RuleResult) {
  return { id: r.rule.id, hop: r.rule.hop, title: r.rule.title, severity: r.severity, hint: r.rule.hint, autoFix: !!r.rule.fix, findings: r.findings };
}

function onlyFlag(flags: Flags): string[] | undefined {
  return typeof flags.only === 'string' ? flags.only.split(',') : undefined;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export async function main(argv: string[]): Promise<number> {
  const { command: rawCommand, flags } = parseArgs(argv);
  // `ngx-upgrade-doctor --target 8` is shorthand for scan.
  const command = rawCommand || (flags.target ? 'scan' : undefined);
  if (!command || flags.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === 'rules') return cmdRules();

  const project = new Project(typeof flags.project === 'string' ? flags.project : process.cwd());
  if (project.angularMajor === undefined) throw new Error('@angular/core not found in package.json.');
  switch (command) {
    case 'scan': return cmdScan(project, flags);
    case 'fix': return cmdFix(project, flags);
    case 'current': return cmdCurrent(project, flags);
    case 'deps': return cmdDeps(project, flags);
    case 'plan': return cmdPlan(project, flags);
    case 'types': return cmdTypes(project, flags);
    default:
      console.error(`Unknown command "${command}".`);
      console.log(HELP);
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(c.red(`Error: ${err.message}`));
      process.exit(2);
    },
  );
}
