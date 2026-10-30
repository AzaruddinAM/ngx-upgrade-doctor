import { Rule } from './types';
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

/** Rewrites one `import {..} from 'rxjs/..'`; returns undefined when it needs a human. */
export function rewriteRxjsImport(specifiers: string, from: string): string | undefined {
  let target: string;
  if (RXJS_OPERATOR_PATH.test(from)) target = 'rxjs/operators';
  else if (RXJS_ROOT_PATH.test(from)) target = 'rxjs';
  else return undefined;

  const parts = specifiers.split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
    // ErrorObservable, EmptyObservable, ... have no 1:1 replacement.
    if (/Observable$/.test(imported) && imported !== 'Observable' && imported !== 'ConnectableObservable') return undefined;
    const renamed = RXJS_RENAMES[imported];
    const name = local || imported;
    out.push(renamed ? `${renamed} as ${name}` : local ? `${imported} as ${local}` : imported);
  }
  return `import { ${out.join(', ')} } from '${target}';`;
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
    return [
      ...scanFiles(project, files, /from\s*['"](rxjs\/(?!operators['"]|ajax['"]|webSocket['"]|testing['"]|fetch['"])[^'"]+)['"]/,
        (m) => `Deep import '${m[1]}'${rewritable(m[1]) ? ' (auto-fixable)' : ' (manual)'}`),
      ...scanFiles(project, files, /import\s*['"](rxjs\/add\/[^'"]+)['"]/, (m) => `Patch import '${m[1]}' — convert the call chain to .pipe() (manual)`),
      ...scanFiles(project, files, /from\s*['"]rxjs\/Rx['"]/, 'Import from rxjs/Rx pulls all of RxJS 5 — import the symbols you use from "rxjs" (manual)'),
    ];
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) =>
      text.replace(RXJS_DEEP_IMPORT, (whole, specs: string, _q: string, from: string) => rewriteRxjsImport(specs, from) || whole));
  },
};

function rewritable(from: string): boolean {
  return RXJS_OPERATOR_PATH.test(from) || RXJS_ROOT_PATH.test(from);
}

const rxjsCompat: Rule = {
  id: 'rxjs/compat-package',
  hop: 'v6-12',
  title: 'rxjs-compat is still installed',
  since: 6,
  deprecatedIn: 8,
  hint: 'Once `scan` shows no rxjs/deep-imports findings, `npm uninstall rxjs-compat` and rebuild. It does not exist for RxJS 7.',
  check: ({ project }) => depFinding(project, 'rxjs-compat', 'remove after cleaning deep imports (blocks RxJS 7).'),
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
  rxjsDeepImports, rxjsCompat, angularHttp, lazyStringRoutes, viewChildStatic, coreJsPaths,
  entryComponents, rendererV1, testBedGet, moduleWithProviders, enableIvyFalse, ngccPostinstall,
];
