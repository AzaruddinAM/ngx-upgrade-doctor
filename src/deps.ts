import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as semver from 'semver';
import { Project } from './project';
import { requirementsFor, recommendedFromRange } from './versions';

export type DepAction = 'ng-update' | 'upgrade' | 'remove' | 'replace' | 'ok' | 'check';

export interface DepAdvice {
  name: string;
  current: string;
  action: DepAction;
  suggested?: string;
  note: string;
  /** Where the suggestion came from. */
  source: 'angular' | 'table' | 'installed-peer' | 'npm-registry' | 'rule';
}

/**
 * Best-known compatible majors for popular Angular libraries, keyed by Angular major.
 * Built from each project's compatibility table; run `deps --online` to confirm
 * against the npm registry's peerDependencies, which is the source of truth.
 */
export const COMPAT_TABLE: Record<string, Record<number, string>> = {
  '@ng-bootstrap/ng-bootstrap': {
    6: '^3.3.1', 7: '^4.2.2', 8: '^5.3.1', 9: '^6.2.0', 10: '^7.0.0', 11: '^9.1.3', 12: '^10.0.0', 13: '^11.0.1',
    14: '^13.1.1', 15: '^14.2.0', 16: '^15.1.2', 17: '^16.0.0', 18: '^17.0.1', 19: '^18.0.0', 20: '^19.0.1',
  },
  'ngx-bootstrap': {
    6: '^3.3.0', 7: '^4.3.0', 8: '^5.6.2', 9: '^6.2.0', 10: '^6.2.0', 11: '^6.2.0', 12: '^7.1.2', 13: '^8.0.0',
    14: '^9.0.0', 15: '^10.3.0', 16: '^11.0.2', 17: '^12.0.0', 18: '^18.1.3', 19: '^19.0.2', 20: '^20.0.0',
  },
  primeng: {
    6: '^6.1.7', 7: '^7.1.3', 8: '^8.1.1', 9: '^9.1.3', 10: '^10.0.3', 11: '^11.4.5', 12: '^12.2.3', 13: '^13.4.1',
    14: '^14.2.3', 15: '^15.4.1', 16: '^16.9.1', 17: '^17.18.0', 18: '^17.18.0', 19: '^19.1.0', 20: '^20.0.0',
  },
  'ngx-toastr': {
    6: '^9.1.2', 7: '^10.2.0', 8: '^11.3.3', 9: '^12.1.0', 10: '^13.2.1', 11: '^13.2.1', 12: '^14.3.0', 13: '^14.3.0',
    14: '^15.2.2', 15: '^16.2.0', 16: '^17.0.2', 17: '^18.0.0', 18: '^19.0.0', 19: '^19.0.0',
  },
  '@ngx-translate/core': {
    6: '^10.0.2', 7: '^11.0.1', 8: '^11.0.1', 9: '^12.1.2', 10: '^13.0.0', 11: '^13.0.0', 12: '^13.0.0', 13: '^14.0.0',
    14: '^14.0.0', 15: '^14.0.0', 16: '^15.0.0', 17: '^15.0.0', 18: '^15.0.0', 19: '^16.0.0', 20: '^16.0.0',
  },
  'ng2-charts': {
    6: '^1.6.0', 7: '^2.2.3', 8: '^2.3.0', 9: '^2.4.2', 10: '^2.4.2', 11: '^2.4.3', 12: '^3.0.11', 13: '^3.0.11',
    14: '^4.1.1', 15: '^4.1.1', 16: '^5.0.4', 17: '^6.0.1', 18: '^6.0.1', 19: '^8.0.0',
  },
};

/** Packages released in lockstep with Angular majors, from the given Angular major on. */
export const LOCKSTEP: Array<{ test: RegExp; from: number; note: string }> = [
  { test: /^@ngrx\//, from: 6, note: 'NgRx majors track Angular — use `ng update @ngrx/store@<N>` to get its migrations.' },
  { test: /^@angular-eslint\//, from: 12, note: 'angular-eslint majors track Angular — `ng update @angular-eslint/schematics@<N>`.' },
  { test: /^@angular-builders\//, from: 8, note: 'angular-builders majors track Angular.' },
];

/** Packages the upgrade removes or replaces, with the Angular major where that happens. */
export const REMOVALS: Array<{ name: RegExp; at: number; action: DepAction; suggested?: string; install?: string; note: string }> = [
  { name: /^@angular\/http$/, at: 8, action: 'remove', note: 'Removed in v8. Migrate to HttpClient (@angular/common/http) first.' },
  { name: /^rxjs-compat$/, at: 8, action: 'remove', note: 'Remove once deep rxjs imports are gone; required before RxJS 7.' },
  { name: /^node-sass$/, at: 12, action: 'replace', suggested: 'sass@^1.32.0', install: 'sass@^1.32.0', note: 'node-sass is unsupported from v12. Replace with sass (Dart Sass).' },
  { name: /^(tslint|codelyzer)$/, at: 12, action: 'replace', suggested: '@angular-eslint/schematics', note: 'TSLint is deprecated. Run `ng add @angular-eslint/schematics` and convert.' },
  { name: /^protractor$/, at: 12, action: 'replace', suggested: 'cypress or playwright', note: 'Protractor is end-of-life.' },
  { name: /^@angular\/flex-layout$/, at: 15, action: 'replace', suggested: 'CSS flex/grid + @angular/cdk/layout', note: 'Deprecated, no releases past 15.' },
  { name: /^@nguniversal\//, at: 17, action: 'replace', suggested: '@angular/ssr', note: '`ng update` to 17 migrates it to @angular/ssr.' },
  { name: /^core-js$/, at: 8, action: 'check', note: 'Not needed for evergreen browsers since v8 (differential loading). Keep only for specific polyfills.' },
];

const ANGULAR_SCOPED = /^@angular\/(?!flex-layout$|fire$)|^@angular-devkit\/|^@schematics\/angular$/;

export interface DepsOptions {
  project: Project;
  target: number;
  online?: boolean;
  registry?: string;
  /** With online: suggest the newest compatible release instead of the smallest upgrade. */
  latest?: boolean;
}

export async function adviseDeps(opts: DepsOptions): Promise<DepAdvice[]> {
  const { project, target } = opts;
  const deps = project.declaredDeps;
  const req = requirementsFor(target);
  const out: DepAdvice[] = [];
  const unknown: string[] = [];

  for (const name of Object.keys(deps).sort()) {
    // The doctor itself is not an Angular library and works with every version.
    if (name === 'ngx-upgrade-doctor') continue;
    const current = project.installedVersion(name) || deps[name];

    const removal = REMOVALS.find((r) => r.name.test(name));
    if (removal && target >= removal.at) {
      out.push({ name, current, action: removal.action, suggested: removal.suggested, note: removal.note, source: 'rule' });
      continue;
    }

    if (ANGULAR_SCOPED.test(name)) {
      out.push({ name, current, action: 'ng-update', suggested: angularRange(name, target), note: 'Updated by ng update.', source: 'angular' });
      continue;
    }

    if (req && (name === 'typescript' || name === 'rxjs' || name === 'zone.js')) {
      const range = name === 'typescript' ? req.typescript : name === 'rxjs' ? req.rxjs : req.zone;
      const ok = satisfiesLoose(current, range);
      out.push({
        name, current, action: ok ? 'ok' : 'upgrade', suggested: range,
        note: ok ? 'Compatible.' : `Angular ${target} needs ${range}${req.verify ? ' (verify on angular.dev)' : ''}.`,
        source: 'angular',
      });
      continue;
    }

    const lockstep = LOCKSTEP.find((l) => l.test.test(name));
    if (lockstep && target >= lockstep.from) {
      const ok = majorOf(current) === target;
      out.push({ name, current, action: ok ? 'ok' : 'upgrade', suggested: `^${target}.0.0`, note: lockstep.note.replace('<N>', String(target)), source: 'table' });
      continue;
    }

    const table = COMPAT_TABLE[name];
    if (table && table[target]) {
      const suggested = table[target];
      const ok = satisfiesLoose(current, suggested);
      out.push({ name, current, action: ok ? 'ok' : 'upgrade', suggested, note: 'From the built-in compatibility table — confirm with --online.', source: 'table' });
      continue;
    }

    const peer = installedAngularPeer(project, name);
    if (peer) {
      const ok = semver.satisfies(`${target}.0.0`, peer, { includePrerelease: true });
      if (ok) {
        out.push({ name, current, action: 'ok', note: `Installed version declares @angular/core ${peer}.`, source: 'installed-peer' });
        continue;
      }
      out.push({ name, current, action: 'upgrade', note: `Installed version only supports @angular/core ${peer}.`, source: 'installed-peer' });
    }
    unknown.push(name);
  }

  if (opts.online) {
    const docs = await fetchRegistryDocs(unknown.concat(out.filter((a) => a.source === 'table').map((a) => a.name)), opts.registry);
    for (const [name, doc] of docs) {
      const existing = out.find((a) => a.name === name);
      const current = project.installedVersion(name) || deps[name];
      const res = doc && pickVersion(doc, target, current, opts.latest);
      if (!res) continue;
      const currentPeer = peerOf(doc, current);
      const from = semver.valid(current) || (semver.minVersion(current) || { version: '' }).version;
      const downgrade = !!(res.version && from && semver.lt(res.version, from));
      const advice: DepAdvice = currentPeer && semver.satisfies(`${target}.0.0`, currentPeer, { includePrerelease: true })
        ? { name, current, action: 'ok', source: 'npm-registry', note: `Your version already declares @angular/core ${currentPeer}.` }
        : downgrade
        ? {
            name, current, action: 'check', source: 'npm-registry',
            note: `No release at or above ${from} declares Angular ${target}; the newest that does is ${res.version} (older). Check the library's changelog — never downgraded automatically.`,
          }
        : res.version
        ? {
            name, current, suggested: `^${res.version}`, source: 'npm-registry',
            action: satisfiesLoose(current, `^${res.version}`) ? 'ok' : 'upgrade',
            note: res.newest && res.newest !== res.version
              ? `Smallest upgrade that accepts Angular ${target} (${res.peer}); newest compatible is ${res.newest} — use --latest for it.`
              : `Newest release whose peerDependencies accept Angular ${target} (${res.peer}).`,
          }
        : { name, current, action: 'replace', source: 'npm-registry', note: `No published version declares support for Angular ${target} — find an alternative or fork.` };
      if (existing) Object.assign(existing, advice);
      else out.push(advice);
    }
  }

  // Report Angular-peer libraries we could not classify offline.
  for (const name of unknown) {
    if (!out.find((a) => a.name === name) && looksAngular(project, name)) {
      out.push({ name, current: deps[name], action: 'check', note: 'Angular library without a known mapping — run with --online.', source: 'installed-peer' });
    }
  }

  if (req) {
    out.push({
      name: 'node (runtime)', current: process.versions.node,
      action: semver.satisfies(process.versions.node, req.node) ? 'ok' : 'upgrade',
      suggested: req.node, note: `Suggested: Node ${recommendedFromRange(req.node)}.`, source: 'angular',
    });
  }
  return out;
}

export type DepStep = 'ng-update' | 'uninstall' | 'install-save' | 'install-save-dev' | 'manual';

export interface DepCommand {
  step: DepStep;
  /** Shell command to run; for "manual" steps, what to do by hand. */
  command: string;
  packages: string[];
}

export interface DepCommandOptions {
  /** Pass --allow-dirty to ng update. */
  allowDirty?: boolean;
  /** Pass --force to ng update (ignores peer dependency conflicts). */
  ngForce?: boolean;
}

/**
 * The upgrade as ordered steps: ng update first, then uninstalls, then installs
 * split by where each package lives (--save for dependencies, --save-dev for devDependencies).
 */
export function planDepCommands(advice: DepAdvice[], project: Project, target: number, opts: DepCommandOptions = {}): DepCommand[] {
  const pkg = project.pkg;
  const prod = pkg.dependencies || {};
  const deps = project.declaredDeps;
  const ngFlags = `${opts.allowDirty ? ' --allow-dirty' : ''}${opts.ngForce ? ' --force' : ''}`;
  const steps: DepCommand[] = [];

  const ngUpdate = ['@angular/core', '@angular/cli'];
  if (deps['@angular/material']) ngUpdate.push('@angular/material');
  else if (deps['@angular/cdk']) ngUpdate.push('@angular/cdk');
  steps.push({ step: 'ng-update', command: `npx ng update ${ngUpdate.map((p) => `${p}@${target}`).join(' ')}${ngFlags}`, packages: ngUpdate });

  // Lockstep libraries with their own migrations go through ng update too.
  const viaNgUpdate = new Set<string>();
  for (const [prefix, entry] of [['@ngrx/', '@ngrx/store'], ['@angular-eslint/', '@angular-eslint/schematics']]) {
    const group = advice.filter((a) => a.name.startsWith(prefix) && a.action === 'upgrade');
    if (!group.length) continue;
    const main = deps[entry] ? entry : group[0].name;
    steps.push({ step: 'ng-update', command: `npx ng update ${main}@${target}${ngFlags}`, packages: group.map((a) => a.name) });
    group.forEach((a) => viaNgUpdate.add(a.name));
  }

  const uninstall: string[] = [];
  const installs: Record<'install-save' | 'install-save-dev', string[]> = { 'install-save': [], 'install-save-dev': [] };
  const sectionOf = (name: string) => (name in prod ? 'install-save' : 'install-save-dev') as 'install-save' | 'install-save-dev';
  const manual: DepCommand[] = [];

  for (const a of advice) {
    if (a.name === 'node (runtime)' || viaNgUpdate.has(a.name)) continue;
    const removal = REMOVALS.find((r) => r.name.test(a.name));
    if (a.action === 'remove' || (a.action === 'replace' && removal && removal.install)) {
      const users = filesUsing(project, a.name);
      if (users.length) {
        manual.push({ step: 'manual', command: `Kept ${a.name}: still used in ${users.length} file(s), e.g. ${users[0]}. ${a.note}`, packages: [a.name] });
        continue;
      }
      uninstall.push(a.name);
      if (a.action === 'replace' && removal && removal.install) installs[sectionOf(a.name)].push(quoteSpec(removal.install));
    } else if (a.action === 'replace' || a.action === 'check') {
      manual.push({ step: 'manual', command: `${a.name}: ${a.note}${a.suggested ? ` Suggested: ${a.suggested}.` : ''}`, packages: [a.name] });
    } else if (a.action === 'upgrade') {
      if (a.suggested) installs[sectionOf(a.name)].push(quoteSpec(`${a.name}@${a.suggested}`));
      else manual.push({ step: 'manual', command: `${a.name}: ${a.note} Run with --online to find a compatible version.`, packages: [a.name] });
    }
  }

  if (uninstall.length) steps.push({ step: 'uninstall', command: `npm uninstall ${uninstall.join(' ')}`, packages: uninstall });
  if (installs['install-save'].length) {
    steps.push({ step: 'install-save', command: `npm install --save ${installs['install-save'].join(' ')}`, packages: installs['install-save'] });
  }
  if (installs['install-save-dev'].length) {
    steps.push({ step: 'install-save-dev', command: `npm install --save-dev ${installs['install-save-dev'].join(' ')}`, packages: installs['install-save-dev'] });
  }
  return steps.concat(manual);
}

/** Shell commands to apply the advice, in the order they should run. */
export function commandsFor(advice: DepAdvice[], project: Project, target: number, opts: DepCommandOptions = {}): string[] {
  return planDepCommands(advice, project, target, opts).filter((s) => s.step !== 'manual').map((s) => s.command);
}

/** `"name@range"` — quoted so ranges with spaces or < > survive cmd.exe and sh. */
function quoteSpec(spec: string): string {
  return `"${spec}"`;
}

/** Source files that still import a package (rxjs-compat: files with rxjs 5-style deep imports). */
export function filesUsing(project: Project, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = name === 'rxjs-compat'
    ? /from\s*['"]rxjs\/(?!operators['"]|ajax['"]|webSocket['"]|testing['"]|fetch['"])[^'"]+['"]|import\s*['"]rxjs\/add\//
    : new RegExp(`(from\\s*|import\\s*|require\\(\\s*)['"]${escaped}(\\/[^'"]*)?['"]`);
  return project.files('.ts').filter((f) => !f.endsWith('.d.ts') && re.test(project.read(f)));
}

export interface ApplyResult {
  ran: string[];
  failed?: { command: string; code: number };
}

/** Runs the non-manual steps in order, stopping at the first failure. */
export function applyDepCommands(steps: DepCommand[], project: Project, opts: { legacyPeerDeps?: boolean } = {}): ApplyResult {
  const env = { ...process.env, ...(opts.legacyPeerDeps ? { npm_config_legacy_peer_deps: 'true' } : {}) };
  const ran: string[] = [];
  for (const s of steps) {
    if (s.step === 'manual') continue;
    console.log(`\n> ${s.command}`);
    const res = spawnSync(s.command, { cwd: project.root, stdio: 'inherit', shell: true, env });
    if (res.status !== 0) return { ran, failed: { command: s.command, code: res.status === null ? 1 : res.status } };
    ran.push(s.command);
  }
  return { ran };
}

/** npm is the only package manager the apply step drives. */
export function otherPackageManager(project: Project): string | undefined {
  if (project.exists('package-lock.json')) return undefined;
  if (project.exists('yarn.lock')) return 'yarn';
  if (project.exists('pnpm-lock.yaml')) return 'pnpm';
  if (project.exists('bun.lockb') || project.exists('bun.lock')) return 'bun';
  return undefined;
}

export function angularRange(name: string, target: number): string {
  // @angular-devkit/build-angular used 0.x versions before v12 (0.8 for v6, 0.13 for v7, then 0.800, 0.900, ...).
  if (/^@angular-devkit\/(build-angular|build-optimizer|architect|build-webpack)$/.test(name) && target < 12) {
    return target === 6 ? '~0.8.0' : target === 7 ? '~0.13.0' : `~0.${target}00.0`;
  }
  return `^${target}.0.0`;
}

function majorOf(v: string): number | undefined {
  const c = semver.coerce(v);
  return c ? c.major : undefined;
}

function satisfiesLoose(current: string, range: string): boolean {
  const v = semver.valid(current) || (semver.minVersion(current) || { version: '' }).version;
  return !!v && semver.satisfies(v, range);
}

function installedAngularPeer(project: Project, name: string): string | undefined {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(project.root, 'node_modules', name, 'package.json'), 'utf8'));
    const peers = pj.peerDependencies || {};
    return peers['@angular/core'] || peers['@angular/common'];
  } catch {
    return undefined;
  }
}

function looksAngular(project: Project, name: string): boolean {
  return /^(ng[2x]?-|@ng|angular)/.test(name) || !!installedAngularPeer(project, name);
}

interface RegistryResult {
  version?: string;
  peer?: string;
  /** Newest compatible release, for the note when a smaller upgrade was picked. */
  newest?: string;
}

/** The @angular/core peer range of the version matching `current` (exact or lowest in range). */
function peerOf(doc: any, current: string): string | undefined {
  const v = semver.valid(current) || (semver.minVersion(current) || { version: '' }).version;
  const meta = v && doc.versions && doc.versions[v];
  if (!meta || !meta.peerDependencies) return undefined;
  return meta.peerDependencies['@angular/core'] || meta.peerDependencies['@angular/common'];
}

async function fetchRegistryDocs(names: string[], registry = 'https://registry.npmjs.org'): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const queue = [...new Set(names)];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      try {
        const doc = await getJson(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2F')}`);
        out.set(name, doc);
      } catch {
        out.set(name, undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

/** Highest stable, non-deprecated version whose @angular/core peer accepts `target`. */
/**
 * A stable, non-deprecated version whose @angular/core peer accepts `target`.
 * Default: the smallest upgrade from `current` — the newest release of the lowest
 * compatible major at or above it — because many libraries declare open-ended peers
 * (">=13") and their newest major is a much bigger jump than the upgrade needs.
 * With `latest`, or without `current`, the newest compatible release.
 */
export function pickVersion(doc: any, target: number, current?: string, latest = false): RegistryResult | undefined {
  const versions = doc && doc.versions;
  if (!versions) return undefined;
  const candidates = Object.keys(versions).filter((v) => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);
  let anyAngularPeer = false;
  const compatible: Array<{ version: string; peer: string }> = [];
  for (const v of candidates) {
    const meta = versions[v];
    const peers = meta.peerDependencies || {};
    const peer = peers['@angular/core'] || peers['@angular/common'];
    if (!peer) continue;
    anyAngularPeer = true;
    if (meta.deprecated) continue;
    try {
      if (semver.satisfies(`${target}.0.0`, peer, { includePrerelease: true })) compatible.push({ version: v, peer });
    } catch {
      // unparsable range — skip
    }
  }
  // Framework-agnostic package: nothing to change.
  if (!compatible.length) return anyAngularPeer ? {} : undefined;
  const newest = compatible[0];
  const from = current && (semver.valid(current) || (semver.minVersion(current) || { version: '' }).version);
  if (latest || !from) return { ...newest, newest: newest.version };
  const atOrAbove = compatible.filter((c) => semver.gte(c.version, from));
  if (!atOrAbove.length) return { ...newest, newest: newest.version };
  const lowestMajor = Math.min(...atOrAbove.map((c) => semver.major(c.version)));
  const pick = atOrAbove.find((c) => semver.major(c.version) === lowestMajor)!;
  return { ...pick, newest: newest.version };
}

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export interface GitDependency {
  name: string;
  spec: string;
  /** Declared in package.json (true) or pulled in by another package (false). */
  direct: boolean;
}

const GIT_SPEC = /^(git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/|ssh:)|^[\w.-]+\/[\w.-]+(#.*)?$/;

/**
 * Dependencies installed from git or a URL instead of the npm registry. npm 8 (Node 16/18)
 * has to "prepare" them and often fails with "git dep preparation failed" /
 * "Cannot read properties of null (reading 'pickAlgorithm')".
 */
export function gitDependencies(project: Project): GitDependency[] {
  const out: GitDependency[] = [];
  for (const [name, spec] of Object.entries(project.declaredDeps)) {
    if (GIT_SPEC.test(spec)) out.push({ name, spec, direct: true });
  }
  const lock = project.readJson<any>('package-lock.json');
  const seen = new Set(out.map((g) => g.name));
  const add = (name: string, spec: unknown) => {
    if (!name || seen.has(name) || typeof spec !== 'string' || !/^(git\+|git:|github:)/.test(spec)) return;
    seen.add(name);
    out.push({ name, spec, direct: false });
  };
  if (lock && lock.packages) {
    for (const [key, meta] of Object.entries<any>(lock.packages)) {
      add(key.replace(/^.*node_modules\//, ''), meta && (meta.resolved || meta.version));
    }
  } else if (lock && lock.dependencies) {
    const walk = (deps: Record<string, any>) => {
      for (const [name, meta] of Object.entries(deps)) {
        add(name, meta && (meta.version || meta.resolved));
        if (meta && meta.dependencies) walk(meta.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return out;
}
