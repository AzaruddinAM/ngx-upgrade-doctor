import * as fs from 'fs';
import * as path from 'path';
import { Rule, RawFinding } from './types';
import {
  STYLES, addDevDep, configFiles, depFinding, ensureSassUse, importSpecifiers, deadCodeNote, isViewEngineBuild, removeDeps, removeJsonProp, scanFiles, transformFiles, tsFiles,
} from './helpers';
import { packageOf } from './env';
import { Project } from '../project';

// ---------------------------------------------------------------------------
// v10 -> v11
// ---------------------------------------------------------------------------

const asyncTesting: Rule = {
  id: 'testing/async-to-wait-for-async',
  hop: 'v10-11',
  title: 'async() from @angular/core/testing → waitForAsync()',
  since: 11,
  deprecatedIn: 11,
  fixRequires: 11,
  hint: 'Rename the import and every async(...) test wrapper to waitForAsync(...).',
  check({ project }) {
    const files = tsFiles(project).filter((f) => importsAsyncFromTesting(project.read(f)));
    return scanFiles(project, files, /\basync\(\s*(?:\(|inject\b|function\b)/, 'async() test wrapper (auto-fixable)');
  },
  fix({ project }) {
    const files = tsFiles(project).filter((f) => importsAsyncFromTesting(project.read(f)));
    transformFiles(project, files, (text) =>
      text
        .replace(/(import\s*\{[^}]*)\basync\b([^}]*\}\s*from\s*['"]@angular\/core\/testing['"])/, '$1waitForAsync$2')
        .replace(/\basync\((\s*(?:\(|inject\b|function\b))/g, 'waitForAsync($1'));
  },
};

function importsAsyncFromTesting(text: string): boolean {
  return /import\s*\{[^}]*\basync\b[^}]*\}\s*from\s*['"]@angular\/core\/testing['"]/.test(text);
}

// ---------------------------------------------------------------------------
// v11 -> v12: node-sass, TSLint, Material @use theming
// ---------------------------------------------------------------------------

const nodeSass: Rule = {
  id: 'build/node-sass',
  hop: 'v11-12',
  title: 'node-sass is not supported from v12 — use sass (Dart Sass)',
  since: 8,
  deprecatedIn: 11,
  removedIn: 12,
  fixRequires: 8,
  hint: 'npm uninstall node-sass && npm i -D sass. Also remove any "implementation: require(\'node-sass\')" in custom webpack configs.',
  check: ({ project }) => depFinding(project, 'node-sass', 'replace with sass (auto-fixable).'),
  fix({ project }) {
    removeDeps(project, ['node-sass']);
    addDevDep(project, 'sass', '^1.32.0');
  },
};

const tslint: Rule = {
  id: 'lint/tslint',
  hop: 'v11-12',
  title: 'TSLint/Codelyzer → ESLint (angular-eslint)',
  since: 11,
  deprecatedIn: 11,
  // TSLint never breaks `ng build`; only the tslint lint builder stops working.
  hint: 'ng add @angular-eslint/schematics, then ng g @angular-eslint/schematics:convert-tslint-to-eslint <project>, then npm uninstall tslint codelyzer and delete tslint.json.',
  docs: 'https://github.com/angular-eslint/angular-eslint#migrating-an-angular-cli-project-from-codelyzer-and-tslint',
  check({ project }) {
    const out: RawFinding[] = [
      ...depFinding(project, 'tslint', 'TSLint is deprecated.'),
      ...depFinding(project, 'codelyzer', 'Codelyzer is deprecated.'),
      ...scanFiles(project, configFiles(project), /"@angular-devkit\/build-angular:tslint"/, 'angular.json still uses the tslint builder'),
    ];
    if (project.exists('tslint.json')) out.push({ file: 'tslint.json', message: 'tslint.json present' });
    return out;
  },
};

const MATERIAL_THEMING_IMPORT = /^[ \t]*@import\s+['"]~?@angular\/material\/theming['"]\s*;?[ \t]*\r?\n?/m;
const LEGACY_MATERIAL_SASS = /@import\s+['"]~?@angular\/material\/theming['"]|(?<![\w.$-])mat-(core|light-theme|dark-theme|palette|color|typography-config|typography-level|elevation)\(|@include\s+(angular-material-theme|mat-[a-z-]+-(theme|color|typography|density))\(|\$mat-(red|pink|purple|deep-purple|indigo|blue|light-blue|cyan|teal|green|light-green|lime|yellow|amber|orange|deep-orange|brown|grey|gray|blue-grey|blue-gray)(?![\w-])/;
const PALETTES = 'red|pink|purple|deep-purple|indigo|blue|light-blue|cyan|teal|green|light-green|lime|yellow|amber|orange|deep-orange|brown|grey|gray|blue-grey|blue-gray';

/** Converts Angular Material's pre-v12 global Sass API to the @use API. */
export function migrateMaterialSass(text: string): string {
  if (!LEGACY_MATERIAL_SASS.test(text)) return text;
  let out = text.replace(MATERIAL_THEMING_IMPORT, '');
  const rules: Array<[RegExp, string]> = [
    [/@include\s+angular-material-theme\(/g, '@include mat.all-component-themes('],
    [/@include\s+angular-material-color\(/g, '@include mat.all-component-colors('],
    [/@include\s+angular-material-typography\(/g, '@include mat.all-component-typographies('],
    [/(?<![\w.$-])mat-light-theme\(/g, 'mat.define-light-theme('],
    [/(?<![\w.$-])mat-dark-theme\(/g, 'mat.define-dark-theme('],
    [/(?<![\w.$-])mat-palette\(/g, 'mat.define-palette('],
    [/(?<![\w.$-])mat-typography-config\(/g, 'mat.define-typography-config('],
    [/(?<![\w.$-])mat-typography-level\(/g, 'mat.define-typography-level('],
    [/(?<![\w.$-])mat-color\(/g, 'mat.get-color-from-palette('],
    [/(?<![\w.$-])mat-contrast\(/g, 'mat.get-contrast-color-from-palette('],
    [/@include\s+mat-core\(/g, '@include mat.core('],
    [/@include\s+mat-elevation-transition\(/g, '@include mat.elevation-transition('],
    [/@include\s+mat-elevation\(/g, '@include mat.elevation('],
    [/@include\s+mat-([a-z-]+?)-(theme|color|typography|density)\(/g, '@include mat.$1-$2('],
    [new RegExp(`\\$mat-(${PALETTES})(?![\\w-])`, 'g'), 'mat.$$$1-palette'],
  ];
  for (const [re, rep] of rules) out = out.replace(re, rep);
  return ensureSassUse(out, "@use '@angular/material' as mat;");
}

const materialTheming: Rule = {
  id: 'material/legacy-theming-api',
  hop: 'v11-12',
  title: "Material's global Sass API (@import '~@angular/material/theming', mat-core(), mat-palette())",
  since: 12,
  deprecatedIn: 12,
  fixRequires: 12,
  hint: "ng update @angular/material@12 runs this migration; the auto-fix handles files it missed: @use '@angular/material' as mat; then mat.core(), mat.define-palette(mat.$indigo-palette), mat.define-light-theme(), mat.all-component-themes().",
  docs: 'https://github.com/angular/components/blob/12.0.x/guides/theming.md',
  check({ project }) {
    return project.files('.scss').filter((f) => LEGACY_MATERIAL_SASS.test(project.read(f))).map((file) => {
      const text = project.read(file);
      const idx = text.search(LEGACY_MATERIAL_SASS);
      return { file, line: text.slice(0, idx).split('\n').length, message: 'Legacy Material theming API (auto-fixable)' };
    });
  },
  fix({ project }) {
    transformFiles(project, project.files('.scss'), migrateMaterialSass);
  },
};

const zoneImports: Rule = {
  id: 'polyfills/zone-dist-imports',
  hop: 'v11-12',
  title: "zone.js/dist/* imports → 'zone.js' and 'zone.js/testing'",
  since: 12,
  deprecatedIn: 12,
  removedIn: 15,
  fixRequires: 12,
  hint: "polyfills.ts: import 'zone.js'; test.ts: import 'zone.js/testing'.",
  check: ({ project }) => scanFiles(project, [...tsFiles(project), ...configFiles(project)], /zone\.js\/dist\/zone(-testing)?/, 'zone.js/dist import (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, [...tsFiles(project), ...configFiles(project)], (text) =>
      text.replace(/zone\.js\/dist\/zone-testing/g, 'zone.js/testing').replace(/zone\.js\/dist\/zone/g, 'zone.js'));
  },
};

const protractor: Rule = {
  id: 'testing/protractor',
  hop: 'v12-15',
  title: 'Protractor is end-of-life',
  since: 12,
  deprecatedIn: 12,
  removedIn: 15,
  hint: 'Move e2e tests to Cypress (ng add @cypress/schematic) or Playwright (ng add playwright-ng-schematics), then remove protractor and the e2e target.',
  check: ({ project }) => depFinding(project, 'protractor', 'not supported by the CLI any more.'),
};

// ---------------------------------------------------------------------------
// v12 -> v13: View Engine removed
// ---------------------------------------------------------------------------

const tildeImports: Rule = {
  id: 'styles/tilde-imports',
  hop: 'v12-13',
  title: "Sass imports starting with '~'",
  since: 13,
  deprecatedIn: 13,
  fixRequires: 12,
  hint: "Drop the '~': @import 'bootstrap/scss/bootstrap'. The esbuild builder (v17+) does not resolve '~' at all.",
  check: ({ project }) => scanFiles(project, project.files(...STYLES), /@(import|use|forward)\s+['"]~/, "'~' module import (auto-fixable)"),
  fix({ project }) {
    transformFiles(project, project.files(...STYLES), (text) => text.replace(/(@(?:import|use|forward)\s+['"])~/g, '$1'));
  },
};

const viewEngineLibraries: Rule = {
  id: 'ivy/view-engine-libraries',
  hop: 'v12-13',
  title: 'Third-party libraries still compiled for View Engine',
  since: 13,
  deprecatedIn: 13,
  removedIn: 16,
  hint: 'Upgrade each library to a version built with Ivy partial compilation (run `ngx-upgrade-doctor deps --target <N> --online`). Libraries with no Ivy release must be replaced or forked — ngcc is gone in v16.',
  check({ project }) {
    const out: RawFinding[] = [];
    const imported = importedPackages(project);
    // Needs installed packages; without node_modules there is nothing to inspect.
    for (const name of Object.keys(project.declaredDeps)) {
      if (name.startsWith('@angular/') || !isViewEngineBuild(project, name)) continue;
      const version = project.installedVersion(name);
      out.push(imported.has(name)
        ? { file: 'package.json', message: `${name}@${version} ships View Engine metadata (needs ngcc)` }
        : { file: 'package.json', severity: 'warning', message: `${name}@${version} ships View Engine metadata but no source file imports it — unused; npm uninstall ${name}` });
    }
    return out;
  },
};

/** Packages imported by any source file (comment-aware). */
function importedPackages(project: Project): Set<string> {
  const out = new Set<string>();
  for (const file of tsFiles(project)) {
    for (const { specifier } of importSpecifiers(project.read(file))) {
      const pkg = packageOf(specifier);
      if (pkg) out.add(pkg);
    }
  }
  return out;
}

/**
 * Drops ComponentFactoryResolver where it only feeds a ViewContainerRef:
 * `vcr.createComponent(this.cfr.resolveComponentFactory(C))` and
 * `const f = this.cfr.resolveComponentFactory(C); ... vcr.createComponent(f)` → `vcr.createComponent(C)`;
 * then the constructor parameter and the import go once nothing else uses them.
 */
export function migrateComponentFactoryResolver(text: string): string {
  let out = text.replace(/\.createComponent\(\s*this\.[\w$]+\.resolveComponentFactory\(\s*([\w$.]+)\s*\)/g, '.createComponent($1');
  const decl = /^[ \t]*(?:const|let)\s+([\w$]+)\s*=\s*this\.[\w$]+\.resolveComponentFactory\(\s*([\w$.]+)\s*\);[ \t]*\r?\n/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(out))) {
    const [line, name, cls] = m;
    const rest = out.slice(m.index + line.length);
    const uses = rest.match(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g')) || [];
    const asArg = rest.match(new RegExp(`\\.createComponent\\(\\s*${name}(?![\\w$])`, 'g')) || [];
    if (!uses.length || uses.length !== asArg.length) continue;
    out = out.slice(0, m.index) + rest.replace(new RegExp(`(\\.createComponent\\(\\s*)${name}(?![\\w$])`, 'g'), `$1${cls}`);
    decl.lastIndex = m.index;
  }
  // The injected resolver, when nothing reads it any more.
  const param = /(?:(?:private|public|protected)\s+)?(?:readonly\s+)?([\w$]+)\s*:\s*ComponentFactoryResolver\b/.exec(out);
  if (param && !new RegExp(`this\\.${param[1]}\\b`).test(out)) {
    out = out.replace(new RegExp(`,\\s*${escapeRe(param[0])}`), '').replace(new RegExp(`${escapeRe(param[0])}\\s*,?\\s*`), '');
  }
  if ((out.match(/\bComponentFactoryResolver\b/g) || []).length === 1) {
    out = out.replace(/(import\s*\{[^}]*?)\s*,?\s*\bComponentFactoryResolver\b\s*(,?)([^}]*\}\s*from\s*['"]@angular\/core['"])/, (_w, a: string, comma: string, b: string) =>
      `${a}${a.trim().endsWith('{') ? '' : comma}${b}`.replace(/\{\s*,/, '{ ').replace(/,\s*\}/, ' }'));
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const componentFactoryResolver: Rule = {
  id: 'core/component-factory-resolver',
  hop: 'v12-22',
  title: 'ComponentFactoryResolver (deprecated in v13, removed in v22)',
  since: 13,
  deprecatedIn: 13,
  removedIn: 22,
  fixRequires: 13,
  hint: 'viewContainerRef.createComponent(MyComponent) takes the class directly — the auto-fix handles that pattern. For resolveComponentFactory(C).create(injector) use createComponent(C, { environmentInjector: appRef.injector, elementInjector: injector }) from @angular/core, then appRef.attachView(ref.hostView).',
  check({ project, version }) {
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      if (!/\bComponentFactoryResolver\b/.test(text)) continue;
      const fixable = !/\bComponentFactoryResolver\b/.test(migrateComponentFactoryResolver(text));
      const what = version >= 22 ? 'removed in Angular 22' : 'deprecated';
      for (const f of scanFiles(project, [file], /\bComponentFactoryResolver\b(?=[\s,)])/, `ComponentFactoryResolver usage — ${what}${deadCodeNote(project, file)}${fixable ? ' (auto-fixable)' : ' (manual)'}`)) {
        out.push({ ...f, fixable });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), migrateComponentFactoryResolver);
  },
};

const hammerLoader: Rule = {
  id: 'core/hammer-loader',
  hop: 'v21-22',
  title: 'HammerLoader / HAMMER_LOADER were removed in Angular 22',
  since: 22,
  removedIn: 22,
  hint: 'Remove the HAMMER_LOADER provider and load hammerjs yourself (import \'hammerjs\' in main.ts) if gestures are still needed; or replace Hammer gestures with pointer events.',
  check: ({ project }) => {
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      if (!/\bHAMMER_LOADER\b|\bHammerLoader\b/.test(text)) continue;
      out.push(...scanFiles(project, [file], /\b(HAMMER_LOADER|HammerLoader)\b/, (m) => `${m[1]} usage — removed in Angular 22${deadCodeNote(project, file)}`));
    }
    return out;
  },
};

const ieBrowserslist: Rule = {
  id: 'build/ie11-browserslist',
  hop: 'v12-13',
  title: 'IE 11 is not supported from v13',
  since: 13,
  deprecatedIn: 13,
  fixRequires: 6,
  hint: 'Remove IE entries from .browserslistrc / browserslist.',
  check({ project }) {
    return scanFiles(project, browserslistFiles(project), /^\s*IE\b.*$/im, (m) => `"${m[0].trim()}" (auto-fixable)`);
  },
  fix({ project }) {
    transformFiles(project, browserslistFiles(project), (text) => text.replace(/^\s*IE\b.*(\r?\n)?/gim, ''));
  },
};

function browserslistFiles(project: { files(...e: string[]): string[] }): string[] {
  return project.files('browserslist', '.browserslistrc');
}

// ---------------------------------------------------------------------------
// v13 -> v14
// ---------------------------------------------------------------------------

const defaultProject: Rule = {
  id: 'workspace/default-project',
  hop: 'v13-14',
  title: '"defaultProject" in angular.json is deprecated',
  since: 14,
  deprecatedIn: 14,
  fixRequires: 14,
  hint: 'Remove it; the CLI uses the project in the current directory.',
  check: ({ project }) => scanFiles(project, configFiles(project), /"defaultProject"\s*:/, '"defaultProject" (auto-fixable)'),
  fix({ project }) {
    transformFiles(project, configFiles(project), (text) => removeJsonProp(text, 'defaultProject', '"[^"]*"'));
  },
};

const untypedForms: Rule = {
  id: 'forms/untyped-forms',
  hop: 'v13-14',
  title: 'Untyped reactive forms',
  since: 14,
  hint: 'ng update 14 renamed FormGroup → UntypedFormGroup to keep the old behaviour. Move them back to typed FormGroup/FormControl one form at a time.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /\bUntyped(FormGroup|FormControl|FormArray|FormBuilder)\b(?!\s*[,}]?\s*from)/, (m) => `${m[0]} — consider a typed ${m[1]}`),
};

export const midRules: Rule[] = [
  asyncTesting, nodeSass, tslint, materialTheming, zoneImports, protractor,
  tildeImports, viewEngineLibraries, componentFactoryResolver, hammerLoader, ieBrowserslist, defaultProject, untypedForms,
];
