import * as semver from 'semver';
import * as ts from 'typescript';
import { Project, lineOf } from '../project';
import { RawFinding, Rule } from './types';
import {
  configFiles, depFinding, removeJsonProp, scanFiles, transformFiles, tsFiles,
} from './helpers';

// ---------------------------------------------------------------------------
// rxjs 5-style deep imports
// ---------------------------------------------------------------------------

const RXJS_DEEP_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])(rxjs\/[^'"]+)\2\s*;?/g;
const RXJS_ROOT_PATH = /^rxjs\/(Observable|Subject|BehaviorSubject|ReplaySubject|AsyncSubject|Subscription|Subscriber|Notification|Scheduler|observable\/\w+|scheduler\/\w+)$/;
const RXJS_OPERATOR_PATH = /^rxjs\/operators\/\w+$/;
const RXJS_RENAMES: Record<string, string> = {
  fromPromise: 'from',
  _throw: 'throwError',
  async: 'asyncScheduler',
  asap: 'asapScheduler',
  queue: 'queueScheduler',
  animationFrame: 'animationFrameScheduler',
};

const RXJS_INTERNAL_OPERATOR_PATH = /^rxjs\/internal\/operators\/\w+$/;
const RXJS_INTERNAL_PATH = /^rxjs\/internal\/[\w/]+$/;
/** Public exports of the "rxjs" entry point (RxJS 6.x and 7.x); rxjs/internal/* imports of these move to "rxjs". */
const RXJS_PUBLIC = new Set([
  'Observable', 'ConnectableObservable', 'GroupedObservable', 'observable', 'Subject', 'BehaviorSubject', 'ReplaySubject',
  'AsyncSubject', 'asapScheduler', 'asyncScheduler', 'queueScheduler', 'animationFrameScheduler', 'VirtualTimeScheduler',
  'VirtualAction', 'Scheduler', 'Subscription', 'Subscriber', 'Notification', 'NotificationKind', 'pipe', 'noop', 'identity',
  'isObservable', 'ArgumentOutOfRangeError', 'EmptyError', 'ObjectUnsubscribedError', 'UnsubscriptionError', 'TimeoutError',
  'bindCallback', 'bindNodeCallback', 'combineLatest', 'concat', 'defer', 'empty', 'forkJoin', 'from', 'fromEvent',
  'fromEventPattern', 'generate', 'iif', 'interval', 'merge', 'never', 'of', 'onErrorResumeNext', 'pairs', 'partition',
  'race', 'range', 'throwError', 'timer', 'using', 'zip', 'scheduled', 'EMPTY', 'NEVER', 'config',
  'Operator', 'Observer', 'PartialObserver', 'Subscribable', 'SubscribableOrPromise', 'ObservableInput', 'ObservedValueOf',
  'OperatorFunction', 'MonoTypeOperatorFunction', 'UnaryFunction', 'SchedulerLike', 'SchedulerAction', 'TeardownLogic',
  'Unsubscribable', 'SubscriptionLike',
]);

/** Rewrites one `import {..} from 'rxjs/..'`; returns undefined when it needs a human. */
export function rewriteRxjsImport(specifiers: string, from: string): string | undefined {
  let target: string;
  if (RXJS_OPERATOR_PATH.test(from) || RXJS_INTERNAL_OPERATOR_PATH.test(from)) target = 'rxjs/operators';
  else if (RXJS_ROOT_PATH.test(from) || RXJS_INTERNAL_PATH.test(from) || from === 'rxjs/Rx') target = 'rxjs';
  else return undefined;
  // rxjs/Rx and rxjs/internal/* export more than "rxjs" does: only public symbols can move.
  const internalRoot = target === 'rxjs' && (RXJS_INTERNAL_PATH.test(from) || from === 'rxjs/Rx');

  const parts = specifiers.split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
    // ErrorObservable, EmptyObservable, ... have no 1:1 replacement.
    if (/Observable$/.test(imported) && imported !== 'Observable' && imported !== 'ConnectableObservable') return undefined;
    const renamed = RXJS_RENAMES[imported];
    // Only symbols "rxjs" really exports; internal helpers (e.g. subscribeToResult) stay manual.
    if (internalRoot && !RXJS_PUBLIC.has(renamed || imported)) return undefined;
    const name = local || imported;
    out.push(renamed ? `${renamed} as ${name}` : local ? `${imported} as ${local}` : imported);
  }
  return `import { ${out.join(', ')} } from '${target}';`;
}

// ---------------------------------------------------------------------------
// rxjs 5-style patch imports (rxjs/add/*, rxjs/Rx): the simple cases are safe to automate
// ---------------------------------------------------------------------------

/** RxJS 6 operators (rxjs/operators) — names a patch import can add to Observable.prototype. */
const RXJS_OPERATOR_NAMES = new Set([
  'audit', 'auditTime', 'buffer', 'bufferCount', 'bufferTime', 'bufferToggle', 'bufferWhen', 'catchError', 'combineAll',
  'concatAll', 'concatMap', 'concatMapTo', 'count', 'debounce', 'debounceTime', 'defaultIfEmpty', 'delay', 'delayWhen',
  'dematerialize', 'distinct', 'distinctUntilChanged', 'distinctUntilKeyChanged', 'elementAt', 'endWith', 'exhaust',
  'exhaustMap', 'expand', 'first', 'groupBy', 'ignoreElements', 'isEmpty', 'last', 'mapTo', 'materialize', 'max',
  'mergeAll', 'mergeMap', 'flatMap', 'mergeMapTo', 'mergeScan', 'min', 'multicast', 'observeOn', 'pairwise', 'pluck',
  'publish', 'publishBehavior', 'publishLast', 'publishReplay', 'refCount', 'repeat', 'repeatWhen', 'retry', 'retryWhen',
  'sample', 'sampleTime', 'scan', 'sequenceEqual', 'share', 'shareReplay', 'single', 'skip', 'skipLast', 'skipUntil',
  'skipWhile', 'startWith', 'subscribeOn', 'switchAll', 'switchMap', 'switchMapTo', 'take', 'takeLast', 'takeUntil',
  'takeWhile', 'tap', 'throttle', 'throttleTime', 'throwIfEmpty', 'timeInterval', 'timeout', 'timeoutWith', 'timestamp',
  'toArray', 'window', 'windowCount', 'windowTime', 'windowToggle', 'windowWhen', 'withLatestFrom', 'zipAll',
  'map', 'filter', 'find', 'findIndex', 'every', 'reduce', 'concat', 'some', 'catch', 'finally', 'do', 'let', 'switch', 'toPromise',
]);

/** Patch operators whose name is also an Array/Promise method: `.map(` may well be Array.prototype.map. */
const AMBIGUOUS_OPERATORS = new Set(['map', 'filter', 'find', 'findIndex', 'every', 'reduce', 'concat', 'some', 'catch', 'finally', 'do', 'let', 'switch']);
/** Patch operators that still exist as Observable methods in RxJS 7. */
const STILL_METHODS = new Set(['toPromise', 'subscribe', 'pipe', 'forEach', 'lift']);
const PATCH_IMPORT = /^[ \t]*import\s*(['"])rxjs\/(?:add\/(operator|observable)\/(\w+)|Rx)\1\s*;?[ \t]*\r?\n?/gm;

/** `.debounceTime(500).subscribe(` → `.pipe(debounceTime(500)).subscribe(`, for one unambiguous patch operator. */
export function pipeSinglePatchOperators(text: string): { text: string; operators: string[] } {
  const operators = new Set<string>();
  const re = /(?<=[\w$])\.([a-zA-Z]\w*)\(/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const op = m[1];
    if (AMBIGUOUS_OPERATORS.has(op) || STILL_METHODS.has(op) || !RXJS_OPERATOR_NAMES.has(op)) continue;
    let depth = 0;
    let k = m.index + m[0].length;
    for (; k < text.length; k++) {
      if (text[k] === '(') depth++;
      else if (text[k] === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (!/^\s*\.subscribe\(/.test(text.slice(k + 1))) continue;
    out += `${text.slice(last, m.index)}.pipe(${op}(${text.slice(m.index + m[0].length, k)}))`;
    last = k + 1;
    re.lastIndex = k + 1;
    operators.add(op);
  }
  return { text: out + text.slice(last), operators: [...operators] };
}

/** Adds `import { a, b } from 'rxjs/operators'` (merging into an existing one). */
export function ensureOperatorImports(text: string, names: string[]): string {
  if (!names.length) return text;
  const existing = /import\s*\{([^}]*)\}\s*from\s*(['"])rxjs\/operators\2\s*;?/.exec(text);
  if (existing) {
    const have = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
    const all = [...have, ...names.filter((n) => !have.includes(n))];
    return text.replace(existing[0], `import { ${all.join(', ')} } from 'rxjs/operators';`);
  }
  const imports = /^import[^;]*;[ \t]*$/gm;
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = imports.exec(text))) end = m.index + m[0].length;
  const line = `import { ${names.join(', ')} } from 'rxjs/operators';`;
  return end ? `${text.slice(0, end)}\n${line}${text.slice(end)}` : `${line}\n${text}`;
}

/** Patch names (`operator/debounceTime`, `observable/of`) a file still calls: `.debounceTime(`, `Observable.of(`. */
function patchesUsed(text: string): Set<string> {
  const used = new Set<string>();
  const re = /(?<=[\w$)\]])\.([a-zA-Z]\w*)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (RXJS_OPERATOR_NAMES.has(m[1]) && !AMBIGUOUS_OPERATORS.has(m[1])) used.add(`operator/${m[1]}`);
  const st = /\bObservable\.(\w+)\(/g;
  while ((m = st.exec(text))) used.add(`observable/${m[1]}`);
  return used;
}

function patchesImported(text: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(PATCH_IMPORT.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[2] ? `${m[2]}/${m[3]}` : 'Rx');
  return out;
}

/**
 * New contents for files whose patch imports can go: single patch operators are piped first, then an
 * import is dropped when nothing still needs it — project-wide for unambiguous operators and statics,
 * same file for names that are also Array/Promise methods (map, filter, catch, ...).
 */
export function planRxjsPatchFixes(project: Project): Map<string, string> {
  const files = tsFiles(project);
  const piped = new Map<string, string>();
  for (const file of files) {
    const text = project.read(file);
    if (!/rxjs/.test(text)) {
      piped.set(file, text);
      continue;
    }
    const r = pipeSinglePatchOperators(text);
    piped.set(file, r.operators.length ? ensureOperatorImports(r.text, r.operators) : text);
  }
  const used = new Map([...piped].map(([f, t]) => [f, patchesUsed(t)] as [string, Set<string>]));
  const imported = new Map([...piped].map(([f, t]) => [f, patchesImported(t)] as [string, Set<string>]));
  // A patch import can go when its own file does not use it and every other user imports it itself
  // (those imports are kept, since their file uses them). rxjs/Rx patches everything, so it covers all.
  const othersRely = (file: string, patch: string): boolean => files.some((f) => f !== file && used.get(f)!.has(patch)
    && !imported.get(f)!.has(patch) && !imported.get(f)!.has('Rx'));
  const out = new Map<string, string>();
  for (const file of files) {
    const text = piped.get(file)!;
    const own = used.get(file)!;
    const next = text.replace(new RegExp(PATCH_IMPORT.source, 'gm'), (line: string, _q: string, kind?: string, name?: string) => {
      if (!kind) return own.size || [...used.values()].some((u, i) => files[i] !== file && u.size && !imported.get(files[i])!.size) ? line : '';
      const patch = `${kind}/${name}`;
      if (kind === 'operator' && STILL_METHODS.has(name!)) return '';
      if (kind === 'operator' && AMBIGUOUS_OPERATORS.has(name!)) return new RegExp(`\\.${name}\\(`).test(text) ? line : '';
      return own.has(patch) || othersRely(file, patch) ? line : '';
    });
    if (next !== project.read(file)) out.set(file, next);
  }
  return out;
}

/** `x.next()` calls on Subjects whose value type is not void (TS2554 with RxJS 7's `next(value: T)`). */
export function subjectNextWithoutValue(file: string, text: string): Array<{ name: string; type: string; offset: number; end: number }> {
  if (!/Subject\b/.test(text) || !/\.next\(\s*\)/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const subjects = new Map<string, string>();
  const subjectType = (type?: ts.TypeNode, init?: ts.Expression): string | undefined => {
    const fromRef = (t: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments | ts.NewExpression, name: string): string | undefined => {
      if (!/^(Subject|BehaviorSubject|ReplaySubject|AsyncSubject)$/.test(name)) return undefined;
      const arg = t.typeArguments && t.typeArguments[0];
      return arg ? arg.getText(source) : 'unknown';
    };
    if (type && ts.isTypeReferenceNode(type)) return fromRef(type, type.typeName.getText(source));
    if (init && ts.isNewExpression(init)) return fromRef(init, init.expression.getText(source));
    return undefined;
  };
  const collect = (node: ts.Node): void => {
    if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
      const t = subjectType(node.type, node.initializer);
      if (t) subjects.set(node.name.text, t);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const out: Array<{ name: string; type: string; offset: number; end: number }> = [];
  const calls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !node.arguments.length && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'next') {
      const target = node.expression.expression;
      const name = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isIdentifier(target) ? target.text : '';
      const type = subjects.get(name);
      if (type && !/^void$/.test(type.trim())) out.push({ name, type, offset: node.getStart(source), end: node.getEnd() });
    }
    ts.forEachChild(node, calls);
  };
  calls(source);
  return out;
}

const subjectNextWithoutValue_: Rule = {
  id: 'rxjs/subject-next-without-value',
  hop: 'v21-22',
  title: 'Subject.next() without a value (TS2554 with RxJS 7)',
  since: 22,
  removedIn: 22,
  fixRequires: 6,
  hint: "RxJS 7 types next(value: T) with a required value unless T is void, so `subject.next()` on a Subject<string> or untyped `new Subject()` no longer compiles; tsc only shows it after the RxJS bump. The auto-fix passes undefined explicitly — exactly what RxJS 6 emitted. Under strictNullChecks prefer declaring the subject as Subject<void> when it only signals.",
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      for (const c of subjectNextWithoutValue(file, text)) {
        out.push({ file, line: lineOf(text, c.offset), message: `${c.name}.next() on a Subject<${c.type}> → ${c.name}.next(undefined) (auto-fixable)` });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text, file) => {
      for (const c of subjectNextWithoutValue(file, text).reverse()) {
        const call = text.slice(c.offset, c.end).replace(/\(\s*\)$/, '(undefined)');
        text = text.slice(0, c.offset) + call + text.slice(c.end);
      }
      return text;
    });
  },
};

/** One finding per patch import (rxjs/add/*, side-effect rxjs/Rx); auto-fixable when the plan removes it. */
function patchImportFindings(project: Project, files: string[]): RawFinding[] {
  const plan = planRxjsPatchFixes(project);
  const out: RawFinding[] = [];
  for (const file of files) {
    const text = project.read(file);
    const re = new RegExp(PATCH_IMPORT.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = m[0].trim().replace(/^import\s*['"]|['"]\s*;?$/g, '');
      const planned = plan.get(file);
      const removed = planned !== undefined && !planned.includes(m[0].trim());
      out.push({
        file, line: lineOf(text, m.index + m[0].length - m[0].trimStart().length),
        message: removed
          ? `Patch import '${spec}' — nothing needs it once single operators are piped; removed (auto-fixable)`
          : `Patch import '${spec}' — still used as a method chain; convert to .pipe() (manual)`,
      });
    }
  }
  return out;
}

const rxjsDeepImports: Rule = {
  id: 'rxjs/deep-imports',
  hop: 'v6-9',
  title: 'RxJS 5-style deep imports (rxjs/Observable, rxjs/operators/map, rxjs/add/...)',
  since: 6,
  deprecatedIn: 6,
  fixRequires: 6,
  hint: 'Import from "rxjs" and "rxjs/operators". Patch imports (rxjs/add/operator/*) need .pipe() — run `npx rxjs-tslint -p src/tsconfig.app.json` or refactor by hand. Clean these before RxJS 7, which has no rxjs-compat.',
  docs: 'https://github.com/ReactiveX/rxjs/blob/6.x/docs_app/content/guide/v6/migration.md',
  check({ project }) {
    const files = tsFiles(project);
    // Only "(auto-fixable)" findings count towards the fix; the rest are labelled "(manual)".
    const deep: RawFinding[] = [];
    for (const file of files) {
      const text = project.read(file);
      for (const f of scanFiles(project, [file], /(?:import\s*\{([^}]*)\}\s*)?from\s*['"](rxjs\/(?!operators['"]|ajax['"]|webSocket['"]|testing['"]|fetch['"])[^'"]+)['"]/,
        (m) => `Deep import '${m[2]}'${m[1] !== undefined && rewriteInFile(m[1], m[2], text) ? ' (auto-fixable)' : ' (manual)'}`)) deep.push(f);
    }
    return [
      ...deep,
      ...patchImportFindings(project, files),
      ...scanFiles(project, files, RXJS_COMPAT_IMPORT, (m) => `Import from '${m[1]}' — use the pipeable operator from "rxjs/operators" (manual)`),
    ].map((f) => ({ ...f, fixable: !f.message.endsWith('(manual)') }));
  },
  fix({ project }) {
    for (const [file, text] of planRxjsPatchFixes(project)) project.write(file, text);
    transformFiles(project, tsFiles(project), (text) =>
      text.replace(RXJS_DEEP_IMPORT, (whole, specs: string, _q: string, from: string) => rewriteInFile(specs, from, text) || whole));
  },
};

/** rewriteRxjsImport, except that rxjs/Rx's Observable stays while the file calls its patched statics (Observable.of). */
function rewriteInFile(specifiers: string, from: string, text: string): string | undefined {
  if (from === 'rxjs/Rx' && /\bObservable\.\w+\(/.test(text)) return undefined;
  return rewriteRxjsImport(specifiers, from);
}

const RXJS_COMPAT_IMPORT = /(?:from\s*|import\s*)['"](rxjs-compat(?:\/[^'"]*)?)['"]/;
/** Every import that only resolves while rxjs-compat is installed (RxJS 6) — rxjs/internal/* is real RxJS. */
const NEEDS_RXJS_COMPAT = /(?:from\s*|import\s*)['"]((?:rxjs\/(?!operators['"]|ajax['"]|webSocket['"]|testing['"]|fetch['"]|internal\/))[^'"]+|rxjs-compat(?:\/[^'"]*)?)['"]/;

const rxjsCompatMissing: Rule = {
  id: 'rxjs/compat-imports-without-package',
  hop: 'every hop',
  title: 'RxJS 5-style imports without rxjs-compat installed (build breaks)',
  since: 6,
  removedIn: 6,
  hint: 'Do not reinstall rxjs-compat: run the rxjs/deep-imports auto-fix, then turn patch-style chains into pipes — `obs.map(f).delay(1)` → `obs.pipe(map(f), delay(1))`, `Observable.of(x)` → `of(x)`, `.toPromise()` stays a method in RxJS 6 (prefer firstValueFrom/lastValueFrom in 7).',
  docs: 'https://github.com/ReactiveX/rxjs/blob/6.x/docs_app/content/guide/v6/migration.md',
  check({ project }) {
    const rxjs = project.versionOf('rxjs');
    const rxjs7 = !!rxjs && semver.major(rxjs) >= 7;
    if (project.declaredDeps['rxjs-compat'] && !rxjs7) return [];
    const why = rxjs7 ? 'rxjs-compat does not exist for RxJS 7' : 'rxjs-compat is not in package.json';
    return scanFiles(project, tsFiles(project), NEEDS_RXJS_COMPAT, (m) => `'${m[1]}' only resolves with rxjs-compat (${why})`);
  },
};

const rxjsCompat: Rule = {
  id: 'rxjs/compat-package',
  hop: 'v6-12',
  title: 'rxjs-compat is still installed',
  since: 6,
  deprecatedIn: 8,
  hint: 'Once `scan` shows no rxjs/deep-imports findings, `npm uninstall rxjs-compat` and rebuild. It does not exist for RxJS 7, which Angular 22 requires.',
  check: ({ project, version }) => depFinding(project, 'rxjs-compat', version >= 22
    ? 'Angular 22 requires RxJS 7, and rxjs-compat only exists for RxJS 6 — clean deep imports, then uninstall it.'
    : 'remove after cleaning deep imports (blocks RxJS 7).').map((f) => (version >= 22 ? { ...f, severity: 'error' as const } : f)),
};

// ---------------------------------------------------------------------------
// v7 -> v8
// ---------------------------------------------------------------------------

const angularHttp: Rule = {
  id: 'core/angular-http',
  hop: 'v7-8',
  title: '@angular/http was removed in v8',
  since: 6,
  deprecatedIn: 6,
  removedIn: 8,
  hint: 'Replace HttpModule → HttpClientModule, Http → HttpClient (from @angular/common/http). Drop `.map(res => res.json())` — HttpClient parses JSON. Headers/RequestOptions → HttpHeaders/HttpParams.',
  docs: 'https://v8.angular.io/guide/deprecations#angularhttp',
  check({ project }) {
    return [
      ...scanFiles(project, tsFiles(project), /from\s*['"]@angular\/http(\/testing)?['"]/, 'Import from @angular/http'),
      ...depFinding(project, '@angular/http', 'remove after migrating to HttpClient.'),
    ];
  },
};

const lazyStringRoutes: Rule = {
  id: 'router/string-load-children',
  hop: 'v7-8',
  title: 'String-based loadChildren ("./x.module#XModule")',
  since: 8,
  deprecatedIn: 8,
  removedIn: 13,
  fixRequires: 8,
  hint: 'Use dynamic imports: loadChildren: () => import(\'./x.module\').then(m => m.XModule). Requires "module": "esnext" in tsconfig.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /loadChildren\s*:\s*(['"])[^'"]*#\w+\1/, 'String loadChildren (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) =>
      text.replace(/loadChildren\s*:\s*(['"])([^'"#]+)#(\w+)\1/g, (_w, _q, p: string, mod: string) =>
        `loadChildren: () => import('${p}').then(m => m.${mod})`));
  },
};

const viewChildStatic: Rule = {
  id: 'core/view-child-static',
  hop: 'v7-8',
  title: '@ViewChild/@ContentChild need { static } in v8',
  since: 8,
  until: 8,
  level: 'warning',
  hint: '`ng update @angular/core@8` adds { static: true|false } for you; check any it marks with a TODO.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /@(ViewChild|ContentChild)\(\s*[^,()]+\)/, (m) => `@${m[1]} without { static } option`),
};

const coreJsPaths: Rule = {
  id: 'polyfills/core-js-es7',
  hop: 'v7-8',
  title: 'core-js 2 polyfill paths (core-js/es6, core-js/es7)',
  since: 8,
  deprecatedIn: 8,
  fixRequires: 8,
  hint: 'Angular 8 uses core-js 3 and differential loading; es6/es7 paths no longer exist. Most of these imports can simply be deleted for evergreen browsers.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /import\s*['"]core-js\/es[67]\/[^'"]+['"]/, 'core-js 2 import path (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) =>
      text
        .replace(/core-js\/es7\/reflect/g, 'core-js/es/reflect')
        .replace(/core-js\/es[67]\//g, 'core-js/es/'));
  },
};

// ---------------------------------------------------------------------------
// v8 -> v9 (Ivy)
// ---------------------------------------------------------------------------

const entryComponents: Rule = {
  id: 'ivy/entry-components',
  hop: 'v8-9',
  title: 'entryComponents is unnecessary with Ivy',
  since: 9,
  deprecatedIn: 9,
  fixRequires: 9,
  hint: 'Delete entryComponents from @NgModule/@Component — Ivy finds dynamically created components itself.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /\bentryComponents\s*:/, 'entryComponents (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) =>
      text.replace(/\n?[ \t]*entryComponents\s*:\s*(\[[^\]]*\]|[\w.]+)\s*,?/g, ''));
  },
};

const rendererV1: Rule = {
  id: 'core/renderer-v1',
  hop: 'v8-9',
  title: 'Renderer (v1) was removed in v9',
  since: 6,
  deprecatedIn: 6,
  removedIn: 9,
  hint: 'Use Renderer2: setElementStyle → setStyle, setElementClass → addClass/removeClass, setElementAttribute → setAttribute, invokeElementMethod → call the method on el.nativeElement.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /import\s*\{[^}]*\bRenderer\b[^}]*\}\s*from\s*['"]@angular\/core['"]/, 'Renderer imported from @angular/core'),
};

const testBedGet: Rule = {
  id: 'testing/testbed-get',
  hop: 'v8-9',
  title: 'TestBed.get() → TestBed.inject()',
  since: 9,
  deprecatedIn: 9,
  fixRequires: 9,
  hint: 'TestBed.inject() is type-safe; replace every TestBed.get().',
  check: ({ project }) => scanFiles(project, tsFiles(project), /\bTestBed\.get\s*\(/, 'TestBed.get() (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) => text.replace(/\bTestBed\.get(\s*\()/g, 'TestBed.inject$1'));
  },
};

const moduleWithProviders: Rule = {
  id: 'core/module-with-providers-generic',
  hop: 'v9-10',
  title: 'ModuleWithProviders needs a generic type in v10',
  since: 9,
  deprecatedIn: 9,
  removedIn: 10,
  fixRequires: 7,
  hint: 'static forRoot(): ModuleWithProviders<MyModule>. For third-party libraries, upgrade the library.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /:\s*ModuleWithProviders\b(?!\s*<)/, 'ModuleWithProviders without a type argument'),
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) =>
      text.replace(/(:\s*ModuleWithProviders\b)(?!\s*<)/g, (whole, head: string, offset: number) => {
        const body = text.slice(offset, offset + 600);
        const m = /ngModule\s*:\s*([A-Za-z_$][\w$]*)/.exec(body);
        return m ? `${head}<${m[1]}>` : whole;
      }));
  },
};

const enableIvyFalse: Rule = {
  id: 'ivy/enable-ivy-false',
  hop: 'v9-13',
  title: '"enableIvy": false (View Engine opt-out)',
  since: 9,
  deprecatedIn: 12,
  removedIn: 13,
  fixRequires: 9,
  hint: 'Remove the flag and fix whatever Ivy complains about; View Engine is gone in v13.',
  check: ({ project }) => scanFiles(project, configFiles(project), /"enableIvy"\s*:\s*false/, '"enableIvy": false (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, configFiles(project), (text) => removeJsonProp(text, 'enableIvy', 'false'));
  },
};

const ngccPostinstall: Rule = {
  id: 'ivy/ngcc-postinstall',
  hop: 'v9-16',
  title: 'ngcc in postinstall (ngcc was removed in v16)',
  since: 9,
  deprecatedIn: 13,
  removedIn: 16,
  fixRequires: 9,
  hint: 'The CLI runs ngcc on demand until v15; from v16 there is no ngcc, so remove it and replace any View Engine-only library.',
  check({ project }) {
    const script = (project.pkg.scripts || {}).postinstall;
    return script && /\bngcc\b/.test(script) ? [{ file: 'package.json', message: `postinstall runs ngcc: "${script}" (auto-fixable)` }] : [];
  },
  fix({ project }) {
    const pkg = project.pkg;
    const scripts = pkg.scripts || {};
    const rest = (scripts.postinstall || '').split('&&').map((s) => s.trim()).filter((s) => s && !/\bngcc\b/.test(s));
    if (rest.length) scripts.postinstall = rest.join(' && ');
    else delete scripts.postinstall;
    project.writeJson('package.json', pkg);
  },
};

export const legacyRules: Rule[] = [
  rxjsDeepImports, rxjsCompatMissing, rxjsCompat, subjectNextWithoutValue_, angularHttp, lazyStringRoutes, viewChildStatic, coreJsPaths,
  entryComponents, rendererV1, testBedGet, moduleWithProviders, enableIvyFalse, ngccPostinstall,
];
