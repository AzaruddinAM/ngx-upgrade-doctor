#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as semver from 'semver';
import { Project } from './project';
import { FixResult, RuleResult, fix, scan, summarize } from './engine';
import {
  CLEAR_CACHE, GitDependency, adviseDeps, applyDepCommands, cliNodeError, displayCommand, gitDependencies, nodeRequirement, otherPackageManager,
  postFixInstallCommand, cliTempFolders, npmLsProblems,
  planDepCommands,
} from './deps';
import { RULES, severityAt } from './rules';
import { invalidInstalls, notInstalled, writeVsCodeSettings } from './rules/v15-v22';
import { nodeVersionMessage, nvmInstalledVersions } from './rules/env';
import { c, printDeps, printFindings, printSummary } from './report';
import { compileDiagnostics, projectTypeScript } from './tsc';
import { templateParseDiagnostics } from './templates';
import { StrictFixKind, applyStrictPlan, enableStrict, planStrictFixes } from './strict';
import { TypeMode, applyTypePlan, collectUntyped, planTypes } from './typer';
import { MAX_VERSION, MIN_VERSION, nodeFit, requirementsFor, suggestedNode } from './versions';

const HELP = `
${c.bold('ngx-upgrade-doctor')} — upgrade Angular one major at a time, with fewer surprises.

${c.bold('Usage')}
  ngx-upgrade-doctor <command> [options]

${c.bold('Commands')}
  scan --target <N>     Report what blocks the upgrade to Angular N (run BEFORE ng update)
  fix  --target <N>     Apply the safe auto-fixes for Angular N (run BEFORE ng update)
  current               Report warnings/errors for the installed version — no upgrade
         --fix          Apply auto-fixes for those
         --install      With fix / --fix: run npm install when a fix changed package.json (asked otherwise)
         --tsc          Also compile with tsc and include its errors
         --all          Include suggestions (info), not only warnings/errors
  deps --target <N>     Suggest dependency versions for Angular N
         --online       Resolve versions from the npm registry using peerDependencies
         --latest       With --online: newest compatible release instead of the smallest upgrade
         --apply        Run the commands: ng update, npm uninstall, npm install --save / --save-dev
         --yes          With --apply: do not ask first     --dry-run  With --apply: print only
         --allow-dirty  Pass --allow-dirty to ng update    --ng-force  Pass --force to ng update
         --legacy-peer-deps  Use npm legacy peer resolution for every command
         --ignore-invalid    Run ng update even though npm ls reports "invalid" packages (it usually stops)
  plan [--target 22]    Print the hop-by-hop plan from the installed version
  types                 Add explicit types to variables, parameters, properties and return types (v22+)
         --mode <m>     infer (default) | any | implicit-any | nullable (possibly-undefined locals → : any)
         --yes          Apply without asking     --no-specs   Skip *.spec.ts
         --skip-callbacks  Leave arr.map(x => ...) style callbacks alone
         --force        Run on versions below 22
  strict                Fix strict-mode compiler errors: TS2564 (name!:), TS2322 null/undefined (as any),
                        TS7053/TS7015 (this[key] → (this as any)[key]), TS7016 (declare module shim),
                        TS18048/TS2532 possibly 'undefined' locals and callback params (res → res: any)
         --enable       Turn strict mode on: fix the errors "strict": true causes, then set it in tsconfig
                        (replaces "strict": false, drops explicit false strict flags; only when no errors remain)
         --force        With --enable: set strict even if errors remain
         --yes          Apply without asking     --no-specs   Skip *.spec.ts
  finalize              Final touch after an upgrade (meant for Angular 22), however it went:
                        1 install library versions compatible with the installed Angular (deps --online --apply)
                        2 apply every auto-fix from any version: styles, Material/MDC, Sass, templates, RxJS,
                          build config, plus subscribe(a, b) → subscribe({ next, error })
                        3 ask for the types pass (--mode nullable fixes "possibly 'undefined'" errors)
                        4 clear .angular/cache   5 report what is left (rules, templates, tsc)
         --yes          Do not ask (types default to --mode nullable)   --dry-run   Change nothing
         --skip-deps, --skip-types, --offline, --no-tsc, --legacy-peer-deps, --mode <m>
  vscode                Write .vscode/settings.json that keeps VS Code from watching node_modules/.angular/dist
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

/** This package's own version, so a cached older `npx` copy is visible at a glance. */
const DOCTOR_VERSION: string = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '?';
  }
})();

function header(project: Project, label: string): void {
  const node = process.versions.node;
  console.log(`${c.bold('ngx-upgrade-doctor')} ${DOCTOR_VERSION} ${c.gray('·')} ${project.pkg.name || project.root} ${c.gray('·')} Angular ${project.angularMajor} ${c.gray('·')} Node ${node}`);
  console.log(c.gray(label));
}

/**
 * After a fix changed package.json (a library swap, @angular/build, …) the new packages must be installed
 * before the next build. --install runs it; an interactive terminal is asked; otherwise the command is printed.
 */
async function installAfterFix(project: Project, flags: Flags, changed: string[]): Promise<void> {
  if (flags['dry-run']) return;
  const fresh = new Project(project.root);
  const command = postFixInstallCommand(fresh, changed, !!flags['legacy-peer-deps']);
  if (!command) return;
  const missing = notInstalled(fresh);
  const why = missing.length ? `${missing.length} package(s) in package.json are not installed (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''})` : 'package.json changed';
  const pm = otherPackageManager(fresh);
  if (pm) {
    console.log(c.yellow(`\n${why} — run your ${pm} install before building.`));
    return;
  }
  let run = !!flags.install;
  if (!run && interactive(flags)) run = !/^n(o)?$/i.test(await ask(`\n${why}. Run "${command}" now? (Y/n) `));
  if (!run) {
    console.log(c.yellow(`\n${why} — the build fails until you run: ${c.cyan(command)}`));
    return;
  }
  const res = await applyDepCommands([{ step: 'install-save', command, packages: missing }], fresh);
  console.log(res.failed
    ? c.red(`\n"${command}" failed (exit ${res.failed.code}). Peer conflicts? Re-run with --legacy-peer-deps.`)
    : c.green(`\nInstalled. ${CLEAR_CACHE}`));
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
    console.log(`\nNext: ${c.cyan(`npx ngx-upgrade-doctor fix --target ${target}`)}, then ${c.cyan(`npx ngx-upgrade-doctor deps --target ${target}`)}`);
  }
  return results.some((r) => r.severity === 'error') ? 1 : 0;
}

async function cmdFix(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const target = targetFrom(flags, current, Math.min(current + 1, MAX_VERSION));
  header(project, `Auto-fix for Angular ${target}${flags['dry-run'] ? ' (dry run)' : ''}`);
  const res = fix({ project, mode: 'target', target, dryRun: !!flags['dry-run'], only: onlyFlag(flags) });
  printFixResult(res, !!flags['dry-run']);
  await installAfterFix(project, flags, res.changedFiles);
  if (res.deferred.length) {
    console.log(`\n${c.yellow('Deferred')} — these fixes need the newer Angular installed. After ng update, run ${c.cyan('npx ngx-upgrade-doctor current --fix')}:`);
    for (const d of res.deferred) console.log(`  • ${d.rule.id} (needs Angular ${d.requires})`);
  }
  const remaining = scan({ project, mode: 'target', target }).filter((r) => r.severity !== 'info');
  if (remaining.length) {
    console.log(`\n${c.bold('Still needs a human:')}`);
    // The re-scan sees the fixed content, so whatever it still finds (including leftovers of applied fixes) needs a human.
    printFindings(remaining, !!flags.verbose);
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
    printFixResult(res, !!flags['dry-run']);
    await installAfterFix(project, flags, res.changedFiles);
  }
  // Re-read after an install, so deps/not-installed reflects what is really in node_modules now.
  if (flags.fix && !flags['dry-run']) project = new Project(project.root);
  const results = filter(scan({ project, mode: 'current', only: onlyFlag(flags) }));
  let tsNote = '';
  // Template syntax errors (NG5002) never reach the TypeScript check; parse templates like ng build does.
  const parsed = await templateParseDiagnostics(project);
  if (parsed.result) results.unshift(parsed.result);
  const parseNote = c.gray(parsed.note);
  if (flags.tsc) {
    const tsInfo = projectTypeScript(project.root);
    const diags = compileDiagnostics(project, tsInfo.ts);
    if (diags) results.unshift(diags);
    tsNote = tsInfo.bundled
      ? c.yellow(`Type-checked with the bundled TypeScript ${tsInfo.version} — the project has no typescript installed, so results may differ from ng build.`)
      : c.gray(`Type-checked with the project's TypeScript ${tsInfo.version}.`);
  }
  if (flags.json) {
    console.log(JSON.stringify({ current, summary: summarize(results), results: results.map(toJson) }, null, 2));
  } else {
    if (!flags.fix) header(project, `Current-version check (Angular ${current}) — no upgrade`);
    printFindings(results, !!flags.verbose);
    printSummary(results);
    console.log(parseNote);
    if (tsNote) console.log(tsNote);
    if (!flags.fix && results.some((r) => r.findings.some((f) => f.fixable))) console.log(`\nApply fixes: ${c.cyan('npx ngx-upgrade-doctor current --fix')}`);
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
  // `ng update` exits at once on an unsupported Node: check before the (slow) registry analysis.
  if (flags.apply && !flags['dry-run']) {
    const node = flags.online ? await nodeRequirement(target, flags.registry as string | undefined) : requirementsFor(target) && { range: requirementsFor(target)!.node };
    if (node && !semver.satisfies(process.versions.node, node.range)) {
      console.log(c.red(`\nNot applying: Node ${process.versions.node} does not fit the Angular ${target} CLI's ${node.range}.`));
      printNodeFix(node.range, target);
      return 1;
    }
  }
  const advice = await adviseDeps({ project, target, online: !!flags.online, latest: !!flags.latest, registry: flags.registry as string | undefined });
  const steps = planDepCommands(advice, project, target, {
    allowDirty: !!flags['allow-dirty'], ngForce: !!flags['ng-force'], legacyPeerDeps: !!flags['legacy-peer-deps'],
  });
  const commands = steps.filter((s) => s.step !== 'manual').map(displayCommand);
  const gitDeps = gitDependencies(project);
  if (flags.json) {
    console.log(JSON.stringify({ current, target, advice, commands, steps, gitDependencies: gitDeps }, null, 2));
    return 0;
  }
  console.log('');
  printDeps(advice);
  console.log(`\n${c.bold('Commands')} (in order):`);
  for (const s of steps.filter((x) => x.step !== 'manual')) console.log(`  ${c.gray(pad(STEP_LABEL[s.step], 18))} ${c.cyan(displayCommand(s))}`);
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

  if (flags.apply && !commands.length) {
    console.log(c.green(`\nNothing to run: the dependencies already fit Angular ${target}.`));
    return 0;
  }
  if (!flags.apply) {
    console.log(`\nRun them automatically: ${c.cyan(`npx ngx-upgrade-doctor deps --target ${target}${flags.online ? ' --online' : ''} --apply`)}`);
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
  // An interrupted ng update leaves angular-cli-tmp-packages-* behind; npm ls then calls them extraneous
  // and the next ng update stops with ELSPROBLEMS. They are the CLI's own temp folders.
  for (const dir of cliTempFolders(project)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(c.gray(`Removed leftover ${path.relative(project.root, dir)} (from an earlier interrupted ng update).`));
  }
  // ng update runs npm ls first and stops on "invalid" packages: check before spending minutes on the steps.
  if (steps.some((s) => s.step === 'ng-update') && !flags['ignore-invalid']) {
    const removed = new Set(steps.filter((s) => s.step === 'uninstall').flatMap((s) => s.packages));
    const blocking = invalidInstalls(project)
      .map((i) => ({ ...i, requiredBy: i.requiredBy.filter((r) => !removed.has(r.pkg)) }))
      .filter((i) => i.requiredBy.length);
    if (blocking.length) {
      console.log(c.red('\nNot running: ng update would stop with ELSPROBLEMS — npm considers these installed packages "invalid":'));
      for (const i of blocking) {
        console.log(`  • ${i.name}@${i.installed}: ${i.requiredBy.map((r) => `${r.pkg}@${r.version} wants ${r.range}${r.peer ? ' (peer)' : ''}`).join('; ')}`);
      }
      const culprits = [...new Set(blocking.flatMap((i) => i.requiredBy.map((r) => r.pkg)))];
      console.log(`Upgrade those packages (${c.cyan(`npx ngx-upgrade-doctor deps --target ${target} --online`)}), or remove the ones you no longer use: ${c.cyan(`npm uninstall ${culprits.join(' ')} --legacy-peer-deps`)}. Then re-run. To try anyway: --ignore-invalid.`);
      return 1;
    }
  }
  const res = await applyDepCommands(steps, project, { legacyPeerDeps: !!flags['legacy-peer-deps'] });
  if (res.failed) {
    console.log(c.red(`\nStopped: "${res.failed.command}" exited with code ${res.failed.code}.`));
    console.log('Fix the error above and re-run; commands that already ran are safe to repeat.');
    // The CLI refused this Node version: --ng-force or a cache clean cannot help.
    const nodeNeeded = cliNodeError(res.failed.stderr);
    if (nodeNeeded) {
      printNodeFix(nodeNeeded.map((v) => `>=${v} <${semver.major(v) + 1}.0.0`).join(' || '), target);
      return 1;
    }
    // npm ls found problems in node_modules (ELSPROBLEMS): ng update stops before installing; --force does not skip it.
    const problems = npmLsProblems(res.failed.stderr);
    if (problems) {
      printNpmLsFix(problems);
      return 1;
    }
    const failedStep = steps.find((s) => s.command === res.failed!.command);
    if (failedStep && failedStep.step === 'ng-update' && !flags['ng-force']) {
      const rerun = process.argv.slice(2).filter((a) => a !== '--yes').concat('--ng-force', '--yes').join(' ');
      console.log(`"Incompatible peer dependencies found"? Re-run with --ng-force (passes --force to ng update): ${c.cyan(`npx ngx-upgrade-doctor ${rerun}`)}`);
    }
    if (!flags['legacy-peer-deps']) console.log(`npm ERESOLVE peer conflicts? Add ${c.cyan('--legacy-peer-deps')} (safer than npm --force).`);
    if (gitDeps.length) console.log(`"git dep preparation failed" or "pickAlgorithm"? Run ${c.cyan('npm cache clean --force')} and re-run — see the git dependencies listed above.`);
    return 1;
  }
  console.log(c.green(`\nDone: ran ${res.ran.length} command(s).`));
  if (flags.finalize) return 0;
  console.log(c.yellow(CLEAR_CACHE));
  console.log(`Next: ${c.cyan('npx ngx-upgrade-doctor current --fix --tsc')}, then ng build and ng test.`);
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
  21: 'ng update REWRITES every *ngIf/*ngFor/*ngSwitch to @if/@for/@switch (slow on big apps; review the diff); TS 5.9 BufferSource typing; zoneless/Vitest defaults for new apps.',
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
    if (req) console.log(c.gray(`   Node ${req.node} (${nodeFit(req.node)}) · TypeScript ${req.typescript}${req.verify ? ' · verify on angular.dev' : ''}`));
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
  if (mode && !['infer', 'any', 'implicit-any', 'nullable'].includes(mode)) throw new Error('--mode must be infer, any, implicit-any or nullable');
  if (!mode && interactive(flags)) {
    console.log('How should types be added?');
    console.log(`  1) infer         ${c.gray('the type TypeScript infers (e.g. string, Observable<User>), any when it cannot be named — recommended')}`);
    console.log(`  2) any           ${c.gray('`: any` on every parameter, variable, property and return type')}`);
    console.log(`  3) implicit-any  ${c.gray('`: any` only where noImplicitAny reports an error')}`);
    console.log(`  4) nullable      ${c.gray("`: any` only on locals/callback parameters strictNullChecks calls possibly 'undefined' (TS18048)")}`);
    const a = await ask('Choose 1-4 [1]: ');
    mode = a === '2' ? 'any' : a === '3' ? 'implicit-any' : a === '4' ? 'nullable' : 'infer';
  }
  mode = mode || 'infer';

  console.log(c.gray(`Analysing with mode "${mode}" (type-checking the workspace)…`));
  const plan = planTypes(project, { mode, includeSpecs: flags.specs !== false, skipCallbacks: !!flags['skip-callbacks'] });
  const total = plan.annotations.length;
  if (!total && !plan.reverted.length) {
    console.log(c.green('Every declaration already has an explicit type.'));
    return offerStrict(project, flags);
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
  return offerStrict(project, { ...flags, fresh: true });
}

const STRICT_LABEL: Record<StrictFixKind, string> = {
  'definite-assignment': 'TS2564 property assigned later → name!:',
  'null-as-any': 'TS2322 null/undefined assigned to a typed value → as any',
  'index-as-any': 'TS7053/TS7015 dynamic index → (x as any)[key]',
  'module-shim': 'TS7016 package without types → declare module',
  'possibly-undefined': 'TS18048/TS2532 possibly undefined/null local or callback parameter → name: any',
};

async function cmdStrict(project: Project, flags: Flags): Promise<number> {
  const enable = !!flags.enable;
  console.log(c.gray(enable
    ? 'Compiling as if tsconfig said "strict": true, to find the errors turning it on would cause…'
    : 'Compiling with the workspace tsconfig to find strict-mode errors…'));
  const plan = planStrictFixes(project, { includeSpecs: flags.specs !== false, strict: enable });
  if (!plan.fixes.length && !enable) {
    console.log(plan.remaining.length
      ? c.yellow(`No auto-fixable strict-mode errors; ${plan.remaining.length} compiler error(s) need a hand (run with --verbose).`)
      : c.green('No strict-mode errors.'));
    if (flags.verbose) for (const r of plan.remaining) console.log(`  ${c.gray(`${r.file}:${r.line}`)}  ${r.message}`);
    return 0;
  }
  const byKind: Partial<Record<StrictFixKind, number>> = {};
  for (const f of plan.fixes) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.log(`\n${c.bold(`${plan.fixes.length} strict-mode fix(es) in ${plan.output.size} file(s)`)}`);
  for (const [kind, n] of Object.entries(byKind)) console.log(`  ${String(n).padStart(4)}  ${STRICT_LABEL[kind as StrictFixKind]}`);
  const sample = flags.verbose ? plan.fixes : plan.fixes.slice(0, 15);
  for (const f of sample) console.log(`  ${c.gray(`${f.file}:${f.line}`)}  TS${f.code} ${c.bold(f.name)}`);
  if (plan.fixes.length > sample.length) console.log(c.gray(`  … and ${plan.fixes.length - sample.length} more (use --verbose)`));
  if (plan.shimFile) {
    console.log(`\nPackages without types are declared in ${c.cyan(plan.shimFile)}. Better, where it exists:`);
    console.log(`  npm install --save-dev ${plan.modules.map((m) => `@types/${m.replace(/^@([^/]+)\//, '$1__')}`).join(' ')}`);
    console.log(c.gray('  then remove the line from the shim. The shim must be in tsconfig.app.json "include" (default: src/**/*.d.ts).'));
  }
  if (plan.reverted.length) {
    console.log(c.yellow(`\nSkipped ${plan.reverted.length} file(s) where the fixes would add compiler errors:`));
    for (const f of plan.reverted) console.log(`  ${f}`);
  }
  if (plan.remaining.length) {
    console.log(c.yellow(`\n${plan.remaining.length} compiler error(s) remain after these fixes and need a hand:`));
    const rest = flags.verbose ? plan.remaining : plan.remaining.slice(0, 10);
    for (const r of rest) console.log(`  ${c.gray(`${r.file}:${r.line}`)}  ${r.message}`);
    if (plan.remaining.length > rest.length) console.log(c.gray(`  … and ${plan.remaining.length - rest.length} more (use --verbose)`));
  }

  if (flags['dry-run']) return 0;
  if (!flags.yes) {
    if (!interactive(flags)) {
      console.log(`\nRe-run with ${c.cyan('--yes')} to apply.`);
      return 0;
    }
    const a = await ask('\nApply these fixes? (y/N) ');
    if (!/^y(es)?$/i.test(a)) {
      console.log('No changes made.');
      return 0;
    }
  }
  applyStrictPlan(project, plan);
  // Flip the tsconfig only when the code compiles under strict, or when asked to anyway.
  if (enable) {
    if (!plan.remaining.length || flags.force) {
      for (const ch of enableStrict(project)) console.log(`  ${c.cyan(ch.file)}: ${ch.changes.join(', ')}`);
      if (plan.remaining.length) console.log(c.yellow(`Strict mode is on with ${plan.remaining.length} error(s) left (--force): the build fails until they are fixed.`));
    } else {
      console.log(c.yellow(`\nStrict mode NOT turned on: ${plan.remaining.length} error(s) still need a hand. Fix them (or re-run with --force), then run ${c.cyan('npx ngx-upgrade-doctor strict --enable')} again.`));
    }
  }
  const written = project.flush(false);
  console.log(c.green(`\nUpdated ${written.length} file(s).`) + ' Run ng build to check template errors too.');
  return 0;
}

/** Opt-in suggestions `finalize` applies on top of the warning/error fixes. */
const FINALIZE_OPT_IN = ['rxjs/subscribe-observer-style', 'material/select-selection-indicator'];

/**
 * The final touch after an upgrade, however it went: dependencies that fit the installed Angular, every
 * auto-fix (styles, Material/MDC, Sass, templates, RxJS, build config) from any earlier hop that still applies,
 * subscribe → { next, error }, the types/strict pass, a fresh build cache, and a last check.
 */
async function cmdFinalize(project: Project, flags: Flags): Promise<number> {
  const current = project.angularMajor!;
  const dryRun = !!flags['dry-run'];
  const step = (n: number, title: string) => console.log(`\n${c.bold(`[${n}/5] ${title}`)}`);
  header(project, `Final touch for Angular ${current}${dryRun ? ' (dry run)' : ''}`);
  if (current < 22) console.log(c.yellow(`Meant for Angular 22 (installed: ${current}); dependencies and fixes still follow the installed version.`));
  let status = 0;

  step(1, `Dependencies compatible with Angular ${current}`);
  if (flags['skip-deps']) {
    console.log(c.gray('Skipped (--skip-deps).'));
  } else {
    status = await cmdDeps(project, { ...flags, target: String(current), online: !flags.offline, apply: true, finalize: true });
    if (status) console.log(c.yellow('Dependencies need attention (see above); continuing with the code fixes.'));
    project = new Project(project.root);
  }

  step(2, 'Code, style and config fixes from every Angular version');
  const res = fix({ project, mode: 'current', dryRun });
  const optIn = fix({ project: new Project(project.root), mode: 'current', dryRun, only: FINALIZE_OPT_IN });
  printFixResult({ ...res, applied: [...res.applied, ...optIn.applied], changedFiles: [...new Set([...res.changedFiles, ...optIn.changedFiles])] }, dryRun);
  if (!dryRun) project = new Project(project.root);
  await installAfterFix(project, flags, res.changedFiles);

  step(3, 'Types');
  if (flags['skip-types']) console.log(c.gray('Skipped (--skip-types).'));
  else if (current < 22 && !flags.force) console.log(c.gray('Skipped: the types pass is for Angular 22+ (--force to run it).'));
  // Unattended runs take the smallest pass: `: any` only where strictNullChecks complains.
  else await cmdTypes(new Project(project.root), { ...flags, force: true, mode: flags.mode || (interactive(flags) ? undefined : 'nullable') });

  step(4, 'Build cache');
  const cache = path.join(project.root, '.angular', 'cache');
  if (!fs.existsSync(cache)) console.log(c.gray('No .angular/cache to clear.'));
  else if (dryRun) console.log('Would clear .angular/cache.');
  else {
    fs.rmSync(cache, { recursive: true, force: true });
    console.log('Cleared .angular/cache, so ng serve does not reuse pre-upgrade bundles.');
  }

  step(5, 'What is left');
  const final = new Project(project.root);
  const left = scan({ project: final, mode: 'current' }).filter((r) => r.severity !== 'info');
  const parsed = await templateParseDiagnostics(final);
  if (parsed.result) left.unshift(parsed.result);
  if (flags.tsc !== false) {
    const diags = compileDiagnostics(final, projectTypeScript(final.root).ts);
    if (diags) left.unshift(diags);
  }
  if (!left.length) console.log(c.green('Nothing left to fix.'));
  else {
    printFindings(left, !!flags.verbose);
    printSummary(left);
  }
  console.log(`\nNext: ${c.cyan('ng build')}, ${c.cyan('ng test --watch=false')}, then ${c.cyan('ng serve')}.`);
  return status || (left.some((r) => r.severity === 'error') ? 1 : 0);
}

/** After the types pass: offer to fix what strict mode still reports. */
async function offerStrict(project: Project, flags: Flags): Promise<number> {
  if (flags['dry-run']) return 0;
  const p = flags.fresh ? new Project(project.root) : project;
  const plan = planStrictFixes(p, { includeSpecs: flags.specs !== false });
  if (!plan.fixes.length) return 0;
  console.log(`\n${c.cyan('ℹ')} Strict mode still reports ${plan.fixes.length} error(s) the tool can fix (TS2564, TS2322, TS7053, TS7015, TS7016, TS18048).`);
  if (!flags.yes && !interactive(flags)) {
    console.log(`   Run ${c.cyan('npx ngx-upgrade-doctor strict')} to fix them.`);
    return 0;
  }
  if (!flags.yes && !/^y(es)?$/i.test(await ask('   Fix them now? (y/N) '))) return 0;
  return cmdStrict(p, { ...flags, yes: true });
}

async function offerTypes(project: Project, flags: Flags): Promise<void> {
  if (flags.json) return;
  const untyped = collectUntyped(project).reduce((n, f) => n + f.count, 0);
  if (!untyped) return;
  console.log(`\n${c.cyan('ℹ')} Angular 22+: ${untyped} declaration(s) have no explicit type.`);
  if (!interactive(flags)) {
    console.log(`   Run ${c.cyan('npx ngx-upgrade-doctor types')} to add them.`);
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

function printFixResult(res: FixResult, dryRun: boolean): void {
  const { applied, changedFiles: changed } = res;
  if (res.unchanged.length) {
    console.log(c.gray(`\nNo automatic change possible for: ${res.unchanged.join(', ')} — see "Still needs a human".`));
  }
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
  return { id: r.rule.id, hop: r.rule.hop, title: r.rule.title, severity: r.severity, hint: r.rule.hint, autoFix: r.findings.some((f) => f.fixable), findings: r.findings };
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
    case 'strict': return cmdStrict(project, flags);
    case 'finalize': return cmdFinalize(project, flags);
    case 'vscode': return cmdVsCode(project, flags);
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

/** What to do when Node does not fit the target CLI: nvm-installed versions that fit, or the one to install. */
function printNodeFix(range: string, target: number): void {
  console.log(nodeVersionMessage(process.versions.node, range, target, nvmInstalledVersions()));
  const major = suggestedNode(range).major;
  console.log(`Fix: ${c.cyan(`nvm install ${major} && nvm use ${major}`)} (or nvm use <an installed version above>), then re-run.`);
}

function cmdVsCode(project: Project, flags: Flags): number {
  const file = writeVsCodeSettings(project);
  const changed = project.flush(!!flags['dry-run']);
  console.log(changed.length ? `${flags['dry-run'] ? 'Would write' : 'Wrote'} ${file} (files.watcherExclude, search.exclude, tsserver memory 3072 MB, no automatic type acquisition).` : `${file} already has these settings.`);
  return 0;
}

/** What to do when ng update stops on `npm ls` problems (npm error code ELSPROBLEMS). */
function printNpmLsFix(problems: { extraneous: string[]; invalid: string[] }): void {
  console.log(c.yellow('\nng update stopped because `npm ls` reports problems in node_modules (ELSPROBLEMS). --ng-force cannot skip this; fix node_modules first:'));
  const temp = problems.extraneous.filter((p) => /^angular-cli-tmp-packages-/.test(p));
  const other = problems.extraneous.filter((p) => !/^angular-cli-tmp-packages-/.test(p));
  if (temp.length) console.log(`  • ${temp.join(', ')}: leftover temp folder from an interrupted ng update — re-running this command removes it.`);
  if (other.length) console.log(`  • extraneous ${other.join(', ')}: installed but not in package.json — ${c.cyan('npm prune --legacy-peer-deps')}`);
  for (const inv of problems.invalid) {
    const name = inv.replace(/@[^@]*$/, '');
    console.log(`  • invalid ${inv}: another package requires a different ${name} version. See which: ${c.cyan(`npm ls ${name}`)} — then upgrade or uninstall that package (often an old library pinned to the previous major), and ${c.cyan('npm install --legacy-peer-deps')}.`);
  }
  console.log(`  Then re-run: ${c.cyan(`npx ngx-upgrade-doctor ${process.argv.slice(2).join(' ')}`)}`);
}
