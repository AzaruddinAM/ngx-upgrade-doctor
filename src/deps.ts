import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as semver from 'semver';
import { Project } from './project';
import { importSpecifiers, isViewEngineBuild, tsFiles } from './rules/helpers';
import { requirementsFor, suggestedNode } from './versions';

export type DepAction = 'ng-update' | 'upgrade' | 'remove' | 'replace' | 'ok' | 'check';

export interface DepAdvice {
  name: string;
  current: string;
  action: DepAction;
  suggested?: string;
  note: string;
  /** Where the suggestion came from. */
  source: 'angular' | 'table' | 'installed-peer' | 'npm-registry' | 'rule';
  /** The installed build ships View Engine metadata (needs ngcc, gone in v16). */
  viewEngine?: boolean;
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
/*
 * `<N>` in `suggested`/`install` is the target major. A `rewritesImports` swap is uninstalled even while
 * still imported, because `fix` rewrites those imports to the replacement.
 */
export const REMOVALS: Array<{
  name: RegExp; at: number; action: DepAction; suggested?: string; install?: string; note: string; rewritesImports?: boolean;
}> = [
  { name: /^@angular\/http$/, at: 8, action: 'remove', note: 'Removed in v8. Migrate to HttpClient (@angular/common/http) first.' },
  { name: /^rxjs-compat$/, at: 8, action: 'remove', note: 'Remove once deep rxjs imports are gone; required before RxJS 7.' },
  { name: /^node-sass$/, at: 12, action: 'replace', suggested: 'sass@^1.32.0', install: 'sass@^1.32.0', note: 'node-sass is unsupported from v12. Replace with sass (Dart Sass).' },
  { name: /^(tslint|codelyzer)$/, at: 12, action: 'replace', suggested: '@angular-eslint/schematics', note: 'TSLint is deprecated. Run `ng add @angular-eslint/schematics` and convert.' },
  { name: /^protractor$/, at: 12, action: 'replace', suggested: 'cypress or playwright', note: 'Protractor is end-of-life.' },
  {
    name: /^@angular\/flex-layout$/, at: 15, action: 'replace', suggested: '@ngbracket/ngx-layout@^<N>.0.0', install: '@ngbracket/ngx-layout@^<N>.0.0',
    rewritesImports: true,
    note: 'Deprecated, no releases past 15, and crashes at runtime on Angular 19+ (NgClass/NgStyle constructors changed). Drop-in fork: @ngbracket/ngx-layout (majors track Angular — confirm its peers with --online). Long term: CSS flex/grid + @angular/cdk/layout.',
  },
  { name: /^@nguniversal\//, at: 17, action: 'replace', suggested: '@angular/ssr', note: '`ng update` to 17 migrates it to @angular/ssr.' },
  {
    name: /^ngx-perfect-scrollbar$/, at: 16, action: 'replace', suggested: 'ngx-om-perfect-scrollbar@^16.0.0', install: 'ngx-om-perfect-scrollbar@^16.0.0',
    rewritesImports: true,
    note: 'View Engine build, abandoned. Drop-in fork ngx-om-perfect-scrollbar (same API); `current --fix` rewrites the imports.',
  },
  {
    name: /^ngx-material-timepicker$/, at: 22, action: 'replace', suggested: 'ngx-mat-timepicker@^<N>.0.0', install: 'ngx-mat-timepicker@^<N>.0.0',
    rewritesImports: true,
    note: 'Abandoned and uses APIs removed in Angular 22. Successor: ngx-mat-timepicker (`current --fix` renames NgxMaterialTimepickerModule, <ngx-material-timepicker> and [ngxTimepicker]; luxon/@types/luxon can go).',
  },
  { name: /^core-js$/, at: 8, action: 'check', note: 'Not needed for evergreen browsers since v8 (differential loading). Keep only for specific polyfills.' },
];

/**
 * Library versions known to break the build from a given Angular major on — usually
 * View Engine libraries that ngcc patched until v16, or typings broken by newer TypeScript.
 */
export const KNOWN_BREAKERS: Array<{ name: string; range: string; at: number; action: DepAction; suggested: string; note: string }> = [
  {
    name: 'ngx-perfect-scrollbar', range: '*', at: 16, action: 'replace', suggested: 'ngx-om-perfect-scrollbar@^16.0.0',
    note: 'Abandoned View Engine library (ngcc is gone in v16). Drop-in fork: ngx-om-perfect-scrollbar (same PerfectScrollbarModule API; `current --fix` rewrites the imports). Longer term: ngx-scrollbar or native overflow-y: auto.',
  },
  {
    name: 'angular-calendar', range: '<0.31.0', at: 16, action: 'upgrade', suggested: '^0.31.1',
    note: 'Older releases are View Engine builds (ngcc is gone in v16); 0.31 is Ivy and accepts Angular 15+.',
  },
  {
    name: 'ngx-material-timepicker', range: '<13.0.0', at: 16, action: 'upgrade', suggested: '^13.0.0',
    note: 'Older versions ship ModuleWithProviders without a type argument (NG6005 / TS2314) that only ngcc papered over.',
  },
  {
    name: 'ngx-webcam', range: '<0.4.0', at: 13, action: 'upgrade', suggested: '^0.4.1',
    note: 'Older versions use MediaStreamError, which TypeScript 4.4+ removed from lib.dom.',
  },
  {
    name: 'ngx-image-cropper', range: '<7.0.0', at: 16, action: 'upgrade', suggested: '^7.0.0',
    note: 'Old releases are View Engine builds (not an NgModule under Ivy without ngcc). The API changed — check imageChangedEvent/output events.',
  },
  {
    name: 'ng2-pdf-viewer', range: '<10.0.0', at: 16, action: 'upgrade', suggested: '^10.0.0',
    note: 'Old releases type against pdfjs-dist 2.0 (PDFJSStatic, PDFSource). Install the pdfjs-dist version its peerDependencies name (10.0.0 → ~2.16.105).',
  },
  {
    name: 'ngx-mat-select-search', range: '<7.0.0', at: 15, action: 'upgrade', suggested: '^7.0.0',
    note: 'Releases before 7 are built for the legacy mat-select: in the MDC panel the sticky search header leaves an empty row above the options, gets a grey box and misaligns. 7.x is the first MDC release.',
  },
  {
    name: 'ngx-mat-select-search', range: '<9.0.0', at: 22, action: 'upgrade', suggested: '^9.0.0',
    note: 'Older releases peer on Material 21 or below (8.0.6 is the last 8.x that accepts 22); the latest, 9.x, accepts Material 17-22.',
  },
  // Angular 22 removed ComponentFactoryResolver and HammerLoader, which these releases import at runtime.
  {
    name: '@swimlane/ngx-charts', range: '<25.0.0', at: 22, action: 'upgrade', suggested: '^25.0.3',
    note: 'Older releases use ComponentFactoryResolver, removed in Angular 22 (fails when a chart renders).',
  },
  {
    name: 'angular-calendar', range: '<0.32.0', at: 22, action: 'upgrade', suggested: '^0.32.2',
    note: 'Older releases use APIs removed in Angular 22. 0.32 needs its peers installed too: angular-draggable-droppable@^9 and angular-resizable-element@^8 (not pulled in under --legacy-peer-deps).',
  },
  {
    name: 'ngx-image-cropper', range: '<9.0.0', at: 22, action: 'upgrade', suggested: '^9.1.7',
    note: 'Older releases use APIs removed in Angular 22. 9.x is a standalone ImageCropperComponent — `ngx-upgrade-doctor current --fix` renames ImageCropperModule after the install.',
  },
  {
    name: 'date-fns', range: '<2.30.0', at: 22, action: 'upgrade', suggested: '^2.30.0',
    note: 'Its ESM build imports @babel/runtime/helpers/esm/typeof, which @babel/runtime 8 (v22 toolchain) no longer exports ("is not exported under the conditions"). 2.30 nests @babel/runtime 7.',
  },
];

/** Libraries whose next major breaks the app's own code: reported as "check", never installed for you. */
export const BREAKING_MAJORS: Record<string, { below: string; note: string }> = {
  jspdf: {
    below: '2.0.0',
    note: 'check: jspdf 2 has breaking API changes (setFontStyle/setFontType, fromHTML/addHTML, text(..., \'center\') removed) — see rule deps/jspdf-2-breaking-api for the uses in your code. Not upgraded just because a peer (jspdf-autotable) asks for ^2.',
  },
};

/** The breaker entry matching a declared/installed version at the given Angular major. */
export function knownBreaker(name: string, current: string, target: number): (typeof KNOWN_BREAKERS)[number] | undefined {
  const v = semver.valid(current) || (semver.minVersion(current.replace(/^npm:.*@/, '')) || { version: '' }).version;
  if (!v) return undefined;
  // A library can be listed for several majors: the latest entry that applies and matches wins.
  return KNOWN_BREAKERS.filter((k) => k.name === name && target >= k.at && semver.satisfies(v, k.range))
    .sort((a, b) => b.at - a.at)[0];
}

const ANGULAR_SCOPED =/^@angular\/(?!flex-layout$|fire$)|^@angular-devkit\/|^@schematics\/angular$/;

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
      out.push({ name, current, action: removal.action, suggested: removal.suggested && removal.suggested.replace('<N>', String(target)), note: removal.note, source: 'rule' });
      continue;
    }

    // Breaking majors a peer range may ask for (jspdf-autotable → jspdf ^2): never an automatic upgrade.
    const breaking = BREAKING_MAJORS[name];
    const currentMin = semver.valid(current) || (semver.minVersion(current.replace(/^npm:.*@/, '')) || { version: '' }).version;
    if (breaking && currentMin && semver.lt(currentMin, breaking.below)) {
      out.push({ name, current, action: 'check', note: breaking.note, source: 'rule' });
      continue;
    }

    const breaker = knownBreaker(name, current, target);
    if (breaker) {
      out.push({ name, current, action: breaker.action, suggested: breaker.suggested, note: breaker.note, source: 'rule' });
      continue;
    }

    if (ANGULAR_SCOPED.test(name)) {
      out.push({ name, current, action: 'ng-update', suggested: angularRange(name, target), note: 'Updated by ng update.', source: 'angular' });
      continue;
    }

    // Same check as the ivy/view-engine-libraries rule, so `deps` and `scan` agree.
    if (target >= 13 && isViewEngineBuild(project, name)) {
      const unused = !filesUsing(project, name).length;
      out.push(unused
        ? { name, current, action: 'remove', source: 'installed-peer', viewEngine: true, note: 'View Engine build that no source file imports — uninstall it.' }
        : { name, current, action: 'upgrade', source: 'installed-peer', viewEngine: true,
            note: `Installed build is View Engine (*.metadata.json, no Ivy partial compilation) and ngcc is gone in v16 — upgrade to a release built for Ivy (run with --online).` });
      if (!unused) unknown.push(name);
      continue;
    }

    if (req && (name === 'typescript' || name === 'rxjs' || name === 'zone.js')) {
      const range = name === 'typescript' ? req.typescript : name === 'rxjs' ? req.rxjs : req.zone;
      const ok = satisfiesLoose(current, range);
      // Forced off RxJS 6 (v22+): go straight to the last 7.x minor rather than the range's floor.
      const rxjs7 = name === 'rxjs' && !ok && !semver.intersects(range, '^6.0.0') && semver.satisfies('7.8.0', range) ? '^7.8.0' : undefined;
      out.push({
        name, current, action: ok ? 'ok' : 'upgrade', suggested: rxjs7 || range,
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
    if (peer && isWildcardRange(peer)) {
      out.push({ name, current, action: 'ok', note: `Installed version declares an unconstrained @angular/core peer (${peer}).`, source: 'installed-peer' });
      continue;
    }
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
    // Also re-check libraries whose installed peer already accepts the target: an open-ended peer
    // can hide a per-Angular-major release that should be installed instead.
    const recheck = out.filter((a) => a.source === 'table' || (a.source === 'installed-peer' && a.action === 'ok' && !/unconstrained/.test(a.note)));
    const docs = await fetchRegistryDocs(unknown.concat(recheck.map((a) => a.name)), opts.registry);
    for (const [name, doc] of docs) {
      const existing = out.find((a) => a.name === name);
      const current = project.installedVersion(name) || deps[name];
      const from = semver.valid(current) || (semver.minVersion(current) || { version: '' }).version;
      if (existing && existing.viewEngine) {
        // Its own peer range may accept any Angular; only a newer release can be the fix.
        const newest = doc && pickVersion(doc, target, current, true);
        const newer = newest && newest.version && from && semver.gt(newest.version, from) ? newest.version : undefined;
        Object.assign(existing, newer
          ? { suggested: `^${newer}`, source: 'npm-registry', note: `Installed build is View Engine; the newest release accepting Angular ${target} is ${newer} — confirm it ships Ivy (no *.metadata.json).` }
          : { action: 'replace', source: 'npm-registry', note: 'Installed build is View Engine and there is no newer release — replace or fork it.' });
        continue;
      }
      const res = doc && pickVersion(doc, target, current, opts.latest);
      if (!res) continue;
      const currentPeer = peerOf(doc, current);
      const downgrade = !!(res.version && from && semver.lt(res.version, from));
      const advice: DepAdvice = currentPeer.known && !currentPeer.peer
        ? {
            name, current, action: 'ok', source: 'npm-registry',
            note: currentPeer.wildcard
              ? `Your version declares an unconstrained @angular/core peer (${currentPeer.wildcard}).`
              : 'Your version declares no @angular/core peer — nothing ties it to an Angular major.',
          }
        : currentPeer.peer && semver.satisfies(`${target}.0.0`, currentPeer.peer, { includePrerelease: true })
        ? (() => {
            // An open-ended peer (">=19") also "accepts" 20, but a library that ships one release per
            // Angular major usually needs the matching one (flex-layout's v19 crash slipped through this way).
            const perMajor = perMajorRelease(doc, target, current);
            return perMajor
              ? {
                  name, current, action: 'upgrade' as const, suggested: `^${perMajor.version}`, source: 'npm-registry' as const,
                  note: `Per-Angular-major releases: ${perMajor.version} declares @angular/core ${perMajor.peer}; yours only accepts ${target} through the open-ended ${currentPeer.peer}.`,
                }
              : { name, current, action: 'ok' as const, source: 'npm-registry' as const, note: `Your version already declares @angular/core ${currentPeer.peer}.` };
          })()
        : downgrade
        ? {
            name, current, action: 'check', source: 'npm-registry',
            note: `No release at or above ${from} declares Angular ${target} in peerDependencies (older ones are not an upgrade path). Check the library's changelog — never downgraded automatically.`,
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

  const node = opts.online ? await nodeRequirement(target, opts.registry) : req && { range: req.node, source: 'table' as const };
  if (node) {
    const fits = semver.satisfies(process.versions.node, node.range);
    const from = node.source === 'npm-registry' ? ` From @angular/cli@${node.cli} engines.node.` : '';
    out.push({
      name: 'node (runtime)', current: process.versions.node,
      action: fits ? 'ok' : 'upgrade',
      suggested: node.range, source: node.source === 'npm-registry' ? 'npm-registry' : 'angular',
      note: fits ? `Fits.${from}` : `Suggested: ${suggestedNode(node.range).text}.${from}`,
    });
  }
  return out;
}

/** engines.node of the newest stable @angular/cli release of a major, from a registry document. */
export function cliNodeRange(doc: any, target: number): { range: string; cli: string } | undefined {
  const versions = (doc && doc.versions) || {};
  const cli = Object.keys(versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.major(v) === target)
    .sort(semver.rcompare)
    .find((v) => versions[v].engines && versions[v].engines.node);
  return cli ? { range: versions[cli].engines.node, cli } : undefined;
}

/**
 * The Node range the target Angular CLI enforces: its engines.node from the registry, falling back
 * to the built-in table (offline, or when the registry has no release of that major yet).
 */
export async function nodeRequirement(target: number, registry?: string): Promise<{ range: string; source: 'npm-registry' | 'table'; cli?: string } | undefined> {
  const docs = await fetchRegistryDocs(['@angular/cli'], registry);
  const live = cliNodeRange(docs.get('@angular/cli'), target);
  if (live) return { range: live.range, source: 'npm-registry', cli: live.cli };
  const req = requirementsFor(target);
  return req ? { range: req.node, source: 'table' } : undefined;
}

/** "requires a minimum Node.js version of v22.22.3 or v24.15.0" → the versions named, from CLI output. */
export function cliNodeError(output: string): string[] | undefined {
  const m = /requires a minimum Node\.js version of ([^\n]+)/i.exec(output);
  if (!m) return undefined;
  return (m[1].match(/v?\d+\.\d+\.\d+/g) || []).map((v) => v.replace(/^v/, ''));
}

export type DepStep = 'ng-update' | 'uninstall' | 'install-save' | 'install-save-dev' | 'manual';

export interface DepCommand {
  step: DepStep;
  /** Shell command to run; for "manual" steps, what to do by hand. */
  command: string;
  packages: string[];
  /** Environment variables the command runs with (shown next to it, since they change npm's behaviour). */
  env?: Record<string, string>;
}

export interface DepCommandOptions {
  /** Pass --allow-dirty to ng update. */
  allowDirty?: boolean;
  /** Pass --force to ng update (ignores peer dependency conflicts). */
  ngForce?: boolean;
  /** npm legacy peer resolution: --legacy-peer-deps on npm commands, npm_config_legacy_peer_deps for ng update's own install. */
  legacyPeerDeps?: boolean;
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
  const npmFlags = opts.legacyPeerDeps ? ' --legacy-peer-deps' : '';
  const ngEnv = opts.legacyPeerDeps ? { env: { npm_config_legacy_peer_deps: 'true' } } : {};
  const steps: DepCommand[] = [];
  const viaNgUpdate = new Set<string>();

  // Libraries that peer on @angular/core and need a bump go into the same ng update: otherwise
  // their old peer range ("@angular/core ^15") makes ng update fail with "Incompatible peer dependencies".
  const peerBumps = advice.filter((a) => a.action === 'upgrade' && a.suggested && !LOCKSTEP.some((l) => l.test.test(a.name))
    && !/^(typescript|rxjs|zone\.js)$/.test(a.name) && (a.source === 'table' || a.viewEngine || !!installedAngularPeer(project, a.name)));
  // Only Angular packages still below the target: on an app already on 22, `ng update @angular/core@22`
  // is pointless and can fail on an unrelated npm ls problem; material/cdk are often a major behind.
  const behind = (name: string): boolean => {
    const v = project.installedVersion(name) || deps[name];
    const min = v && (semver.valid(v) || (semver.minVersion(v.replace(/^npm:.*@/, '')) || { version: '' }).version);
    return !min || semver.major(min) < target;
  };
  const ngUpdate = ['@angular/core', '@angular/cli'].filter(behind);
  if (deps['@angular/material'] && behind('@angular/material')) ngUpdate.push('@angular/material');
  else if (deps['@angular/cdk'] && behind('@angular/cdk')) ngUpdate.push('@angular/cdk');
  if (ngUpdate.length) {
    const specs = [...ngUpdate.map((p) => `${p}@${target}`), ...peerBumps.map((a) => quoteSpec(`${a.name}@${a.suggested}`))];
    steps.push({ step: 'ng-update', command: `npx ng update ${specs.join(' ')}${ngFlags}`, packages: [...ngUpdate, ...peerBumps.map((a) => a.name)], ...ngEnv });
    peerBumps.forEach((a) => viaNgUpdate.add(a.name));
  }

  // Lockstep libraries with their own migrations go through ng update too.
  for (const [prefix, entry] of [['@ngrx/', '@ngrx/store'], ['@angular-eslint/', '@angular-eslint/schematics']]) {
    const group = advice.filter((a) => a.name.startsWith(prefix) && a.action === 'upgrade');
    if (!group.length) continue;
    const main = deps[entry] ? entry : group[0].name;
    steps.push({ step: 'ng-update', command: `npx ng update ${main}@${target}${ngFlags}`, packages: group.map((a) => a.name), ...ngEnv });
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
      const users = removal && removal.rewritesImports ? [] : filesUsing(project, a.name);
      if (users.length) {
        manual.push({ step: 'manual', command: `Kept ${a.name}: still used in ${users.length} file(s), e.g. ${users[0]}. ${a.note}`, packages: [a.name] });
        continue;
      }
      uninstall.push(a.name);
      if (a.action === 'replace' && removal && removal.install) installs[sectionOf(a.name)].push(quoteSpec(removal.install.replace('<N>', String(target))));
      if (removal && removal.rewritesImports && filesUsing(project, a.name).length) {
        manual.push({ step: 'manual', command: `Then rewrite the ${a.name} imports: ngx-upgrade-doctor current --fix.`, packages: [a.name] });
      }
    } else if (a.action === 'replace' || a.action === 'check') {
      manual.push({ step: 'manual', command: `${a.name}: ${a.note}${a.suggested ? ` Suggested: ${a.suggested}.` : ''}`, packages: [a.name] });
    } else if (a.action === 'upgrade') {
      if (a.suggested) installs[sectionOf(a.name)].push(quoteSpec(`${a.name}@${a.suggested}`));
      else manual.push({ step: 'manual', command: `${a.name}: ${a.note} Run with --online to find a compatible version.`, packages: [a.name] });
    }
  }

  // Removals first: stale libraries (old peers on rxjs 6, View Engine builds) leave node_modules "invalid",
  // and ng update aborts on that (npm ELSPROBLEMS) before it installs anything.
  if (uninstall.length) steps.unshift({ step: 'uninstall', command: `npm uninstall ${uninstall.join(' ')}${npmFlags}`, packages: uninstall });
  if (installs['install-save'].length) {
    steps.push({ step: 'install-save', command: `npm install --save ${installs['install-save'].join(' ')}${npmFlags}`, packages: installs['install-save'] });
  }
  if (installs['install-save-dev'].length) {
    steps.push({ step: 'install-save-dev', command: `npm install --save-dev ${installs['install-save-dev'].join(' ')}${npmFlags}`, packages: installs['install-save-dev'] });
  }
  // A stale build cache keeps compiler-generated imports of swapped-out packages ("Module not found").
  if (steps.length) manual.push({ step: 'manual', command: CLEAR_CACHE, packages: [] });
  return steps.concat(manual);
}

export const CLEAR_CACHE = 'Before ng serve, clear the Angular build cache: rm -rf .angular/cache (Windows: rmdir /s /q .angular\\cache).';

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
  const uses = name === 'rxjs-compat'
    ? (spec: string) => /^rxjs-compat(\/|$)|^rxjs\/(?!(operators|ajax|webSocket|testing|fetch)$)/.test(spec)
    : (spec: string) => spec === name || spec.startsWith(`${name}/`);
  // Comment-aware: a commented-out import does not keep a package installed.
  return tsFiles(project).filter((f) => importSpecifiers(project.read(f)).some((i) => uses(i.specifier)));
}

export interface ApplyResult {
  ran: string[];
  /** `stderr`: what the failed command printed there (also shown live), to tailor the recovery hint. */
  failed?: { command: string; code: number; stderr: string };
}

/** A step as it will run, e.g. `npm_config_legacy_peer_deps=true npx ng update ...`. */
export function displayCommand(step: DepCommand): string {
  const env = Object.entries(step.env || {}).map(([k, v]) => `${k}=${v} `).join('');
  return `${env}${step.command}`;
}

/** Runs the non-manual steps in order, stopping at the first failure. */
export async function applyDepCommands(steps: DepCommand[], project: Project, opts: { legacyPeerDeps?: boolean } = {}): Promise<ApplyResult> {
  const base = { ...process.env, ...(opts.legacyPeerDeps ? { npm_config_legacy_peer_deps: 'true' } : {}) };
  const ran: string[] = [];
  for (const s of steps) {
    if (s.step === 'manual') continue;
    const env = { ...base, ...(s.env || {}) };
    console.log(`\n> ${displayCommand(s)}`);
    const res = await runTeeStderr(s.command, project.root, env);
    if (res.code !== 0) return { ran, failed: { command: s.command, code: res.code, stderr: res.stderr } };
    ran.push(s.command);
  }
  return { ran };
}

/** Runs a shell command with stdin/stdout inherited and stderr shown live while also being captured. */
function runTeeStderr(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr += chunk.toString();
    });
    child.on('error', (e) => resolve({ code: 1, stderr: stderr + e.message }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, stderr }));
  });
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

/** `x.x.x`, `*`, `>=0.0.0` and the like accept every version, so they say nothing about Angular support. */
function isWildcardRange(range: string): boolean {
  const r = semver.validRange(range.trim() || '*');
  return r === '*' || r === '>=0.0.0' || r === '>=0.0.0-0';
}

/** A release's @angular/core (or @angular/common) peer range; wildcards count as none. */
export function angularPeer(meta: any): { peer?: string; wildcard?: string } {
  const peers = (meta && meta.peerDependencies) || {};
  const raw: string | undefined = peers['@angular/core'] || peers['@angular/common'];
  if (raw === undefined) return {};
  return isWildcardRange(raw) ? { wildcard: raw } : { peer: raw };
}

/** Major of a peer range's lower bound (">=19.0.0" → 19, "^20.1.0 || ^21.0.0" → 20). */
function peerFloor(range: string): number | undefined {
  try {
    const min = semver.minVersion(range);
    return min ? min.major : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For libraries that publish one release per Angular major: the newest release above `current` whose
 * @angular/core peer starts exactly at `target` (">=20", "^20"), when `current`'s own peer starts below it.
 */
export function perMajorRelease(doc: any, target: number, current: string): { version: string; peer: string } | undefined {
  const versions = doc && doc.versions;
  const from = semver.valid(current) || (semver.minVersion(current) || { version: '' }).version;
  if (!versions || !from || !versions[from]) return undefined;
  const own = angularPeer(versions[from]).peer;
  const ownFloor = own ? peerFloor(own) : undefined;
  if (ownFloor === undefined || ownFloor >= target) return undefined;
  const matching = Object.keys(versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.gt(v, from) && !versions[v].deprecated)
    .map((v) => ({ version: v, peer: angularPeer(versions[v]).peer }))
    .filter((c): c is { version: string; peer: string } => !!c.peer && peerFloor(c.peer) === target
      && semver.satisfies(`${target}.0.0`, c.peer, { includePrerelease: true }))
    .sort((a, b) => semver.rcompare(a.version, b.version));
  if (!matching.length) return undefined;
  // Newest release of the lowest such major: the smallest upgrade, like pickVersion.
  const lowest = Math.min(...matching.map((c) => semver.major(c.version)));
  return matching.find((c) => semver.major(c.version) === lowest);
}

/** The Angular peer of the version matching `current` (exact or lowest in range); `known` when that version is in the document. */
function peerOf(doc: any, current: string): { known: boolean; peer?: string; wildcard?: string } {
  const v = semver.valid(current) || (semver.minVersion(current) || { version: '' }).version;
  const meta = v && doc.versions && doc.versions[v];
  return meta ? { known: true, ...angularPeer(meta) } : { known: false };
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
    // Wildcard peers (x.x.x) accept every Angular and would make any release look compatible.
    const { peer } = angularPeer(meta);
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
    const get = url.startsWith('http:') ? http.get : https.get;
    const req = get(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, timeout: 15000 }, (res) => {
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

/**
 * The install command to run after a fix, or undefined when nothing needs installing: package.json was
 * changed by the fix, or packages it lists are missing from node_modules.
 */
export function postFixInstallCommand(project: Project, changedFiles: string[], legacyPeerDeps = false): string | undefined {
  const missing = fs.existsSync(path.join(project.root, 'node_modules'))
    ? Object.keys(project.declaredDeps).filter((n) => !/^(file|link|git|github|https?):|^\.{0,2}\//.test(project.declaredDeps[n]) && project.installedVersion(n) === undefined)
    : [];
  if (!changedFiles.includes('package.json') && !missing.length) return undefined;
  return `npm install${legacyPeerDeps ? ' --legacy-peer-deps' : ''}`;
}

/** Leftover `angular-cli-tmp-packages-*` folders from an interrupted `ng update` (npm ls then reports them "extraneous"). */
export function cliTempFolders(project: Project): string[] {
  const nm = path.join(project.root, 'node_modules');
  try {
    return fs.readdirSync(nm).filter((n) => /^angular-cli-tmp-packages-/.test(n)).map((n) => path.join(nm, n));
  } catch {
    return [];
  }
}

/** `npm ls` problems in a failed command's output (npm error code ELSPROBLEMS): extraneous and invalid packages. */
export function npmLsProblems(output: string): { extraneous: string[]; invalid: string[] } | undefined {
  if (!/ELSPROBLEMS|^(?:npm error )?(?:extraneous|invalid): /m.test(output)) return undefined;
  const pick = (kind: string): string[] => {
    const re = new RegExp(`(?:^|\\n)(?:npm error )?${kind}: (\\S+)`, 'g');
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(output))) out.add(m[1].replace(/@$/, ''));
    return [...out];
  };
  return { extraneous: pick('extraneous'), invalid: pick('invalid') };
}
