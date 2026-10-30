import * as fs from 'fs';
import * as path from 'path';
import { Rule, RawFinding } from './types';
import {
  STYLES, addDevDep, configFiles, depFinding, ensureSassUse, removeDeps, removeJsonProp, scanFiles, transformFiles, tsFiles,
} from './helpers';

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
  removedIn: 13,
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
    const nm = path.join(project.root, 'node_modules');
    // Needs installed packages; without node_modules there is nothing to inspect.
    if (!fs.existsSync(nm)) return [];
    for (const name of Object.keys(project.declaredDeps)) {
      if (name.startsWith('@angular/')) continue;
      const dir = path.join(nm, name);
      let pkg: any;
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      const hasMetadata = (() => {
        try {
          return fs.readdirSync(dir).some((f) => f.endsWith('.metadata.json'));
        } catch {
          return false;
        }
      })();
      if (hasMetadata || pkg.__processed_by_ivy_ngcc__) {
        out.push({ file: 'package.json', message: `${name}@${pkg.version} ships View Engine metadata (needs ngcc)` });
      }
    }
    return out;
  },
};

const componentFactoryResolver: Rule = {
  id: 'core/component-factory-resolver',
  hop: 'v12-13',
  title: 'ComponentFactoryResolver is deprecated',
  since: 13,
  deprecatedIn: 13,
  hint: 'viewContainerRef.createComponent(MyComponent) accepts the component class directly.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /\bComponentFactoryResolver\b(?=[\s,)])/, 'ComponentFactoryResolver usage'),
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
  tildeImports, viewEngineLibraries, componentFactoryResolver, ieBrowserslist, defaultProject, untypedForms,
];
