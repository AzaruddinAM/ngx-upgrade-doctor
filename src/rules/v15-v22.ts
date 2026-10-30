import { Rule } from './types';
import { STYLES, TEMPLATES, countPerFile, depFinding, scanFiles, transformFiles, tsFiles, configFiles } from './helpers';
import { collectUntyped } from '../typer';

// ---------------------------------------------------------------------------
// v14 -> v17: Material moves to MDC
// ---------------------------------------------------------------------------

/** Swaps MatLegacy* symbols and legacy entry points for their MDC equivalents. */
export function migrateLegacyMaterialTs(text: string): string {
  if (!/@angular\/material\/legacy-|MatLegacy|MAT_LEGACY_/.test(text)) return text;
  return text
    .replace(/@angular\/material\/legacy-([\w-]+)/g, '@angular/material/$1')
    .replace(/\bMatLegacy(\w+)\s+as\s+(\w+)/g, (_w, rest: string, alias: string) => (alias === `Mat${rest}` ? alias : `Mat${rest} as ${alias}`))
    .replace(/\bMatLegacy(\w+)/g, 'Mat$1')
    .replace(/\bMAT_LEGACY_(\w+)\s+as\s+(\w+)/g, (_w, rest: string, alias: string) => (alias === `MAT_${rest}` ? alias : `MAT_${rest} as ${alias}`))
    .replace(/\bMAT_LEGACY_(\w+)/g, 'MAT_$1');
}

export function migrateLegacyMaterialSass(text: string): string {
  return text.replace(/\bmat\.([a-z-]*?)legacy-/g, 'mat.$1');
}

const materialLegacy: Rule = {
  id: 'material/legacy-components',
  hop: 'v15-17',
  title: 'Legacy (non-MDC) Material components were removed in v17',
  since: 15,
  deprecatedIn: 15,
  removedIn: 17,
  fixRequires: 15,
  hint: 'Run `ng generate @angular/material:mdc-migration` on v15/16 first (it rewrites templates and styles), then let the auto-fix switch the remaining imports. Expect visual changes — check density, form-field heights and button padding.',
  docs: 'https://v16.material.angular.io/guide/mdc-migration',
  check({ project }) {
    return [
      ...scanFiles(project, tsFiles(project), /@angular\/material\/legacy-[\w-]+/, (m) => `Legacy entry point ${m[0]} (auto-fixable)`),
      ...scanFiles(project, project.files('.scss'), /\bmat\.[a-z-]*legacy-[a-z-]+/, (m) => `Legacy Sass API ${m[0]} (auto-fixable)`),
    ];
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), migrateLegacyMaterialTs);
    transformFiles(project, project.files('.scss'), migrateLegacyMaterialSass);
  },
};

const MDC_SELECTOR = /\.mat-(form-field-(wrapper|flex|infix|underline|outline|label|prefix|suffix|subscript-wrapper)|button-wrapper|checkbox-(inner-container|frame|background|layout)|tab-(label|header|label-container)|select-(trigger|value|arrow-wrapper)|slide-toggle-(bar|thumb|content)|radio-(outer-circle|inner-circle|container)|chip-list|list-item-content|card-header-text|dialog-container|menu-content|tooltip|paginator-container|input-element)\b/;

const mdcSelectors: Rule = {
  id: 'material/mdc-style-overrides',
  hop: 'v15-17',
  title: 'Style overrides target pre-MDC internal class names',
  since: 15,
  deprecatedIn: 15,
  hint: 'MDC components use .mat-mdc-* classes and a different DOM. Prefer the component tokens/mixins (e.g. mat.form-field-overrides in v18+) over ::ng-deep overrides, and re-check these screens visually.',
  check: ({ project }) => scanFiles(project, project.files(...STYLES), MDC_SELECTOR, (m) => `Override of ${m[0]} will no longer match`),
};

const flexLayout: Rule = {
  id: 'deps/flex-layout',
  hop: 'v14-15',
  title: '@angular/flex-layout is deprecated and no longer published',
  since: 15,
  deprecatedIn: 15,
  hint: 'Replace fxLayout/fxFlex with CSS flexbox/grid (or Tailwind), and fxShow/fxHide with BreakpointObserver from @angular/cdk/layout.',
  check: ({ project }) => depFinding(project, '@angular/flex-layout', 'deprecated; migrate to CSS/CDK layout.'),
};

const classGuards: Rule = {
  id: 'router/class-guards',
  hop: 'v14-15',
  title: 'Class-based route guards and resolvers',
  since: 15,
  hint: 'Functional guards are the recommended form: export const authGuard: CanActivateFn = () => inject(AuthService).isLoggedIn();',
  check: ({ project }) => scanFiles(project, tsFiles(project), /implements\s+[^{]*\b(CanActivate|CanActivateChild|CanDeactivate|CanLoad|CanMatch|Resolve)\b/, (m) => `Class implements ${m[1]}`),
};

// ---------------------------------------------------------------------------
// v16 -> v17+: control flow, standalone, application builder
// ---------------------------------------------------------------------------

const controlFlow: Rule = {
  id: 'template/control-flow',
  hop: 'v17+',
  title: 'Structural directives → built-in control flow (@if, @for, @switch)',
  since: 17,
  deprecatedIn: 20,
  hint: 'ng generate @angular/core:control-flow. *ngIf/*ngFor/*ngSwitch are deprecated since v20 and slated for removal — check the v22 release notes.',
  check({ project }) {
    const files = [...project.files(...TEMPLATES), ...tsFiles(project)];
    return countPerFile(project, files, /\*ng(If|For|Switch(Case|Default)?)\b/, (n) => `${n} structural directive(s)`);
  },
};

const standalone: Rule = {
  id: 'core/standalone',
  hop: 'v17+',
  title: 'NgModule-declared components → standalone',
  since: 15,
  hint: 'ng generate @angular/core:standalone (run its three modes in order). From v19, components are standalone by default.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /@NgModule\s*\(\s*\{[^]*?\bdeclarations\s*:/, 'NgModule with declarations'),
};

const applicationBuilder: Rule = {
  id: 'build/application-builder',
  hop: 'v17+',
  title: 'Webpack browser builder → esbuild application builder',
  since: 17,
  hint: 'ng update @angular/cli --name use-application-builder. Check custom webpack configs, `~` style imports and CommonJS dependencies first.',
  check: ({ project }) => scanFiles(project, configFiles(project), /"@angular-devkit\/build-angular:browser"|"@angular-builders\/custom-webpack:browser"/, (m) => `Uses ${m[0]}`),
};

const nguniversal: Rule = {
  id: 'deps/nguniversal',
  hop: 'v16-17',
  title: '@nguniversal/* moved to @angular/ssr',
  since: 17,
  deprecatedIn: 17,
  hint: 'ng update @angular/core@17 @angular/cli@17 migrates @nguniversal/express-engine to @angular/ssr.',
  check: ({ project }) => Object.keys(project.declaredDeps).filter((d) => d.startsWith('@nguniversal/')).flatMap((d) => depFinding(project, d, 'replaced by @angular/ssr.')),
};

const httpClientModule: Rule = {
  id: 'http/http-client-module',
  hop: 'v17-18',
  title: 'HttpClientModule is deprecated',
  since: 18,
  deprecatedIn: 18,
  hint: 'providers: [provideHttpClient(withInterceptorsFromDi())]. In tests use provideHttpClientTesting().',
  check: ({ project }) => scanFiles(project, tsFiles(project), /\bHttpClient(Testing)?Module\b(?=\s*[,\]])/, (m) => `${m[0]} in imports`),
};

const animationsPackage: Rule = {
  id: 'animations/angular-animations',
  hop: 'v20+',
  title: '@angular/animations is deprecated (since 20.2)',
  since: 20,
  deprecatedIn: 21,
  hint: 'Move to native CSS animations with animate.enter / animate.leave. Replace provideAnimations() with provideAnimationsAsync() meanwhile.',
  check: ({ project }) => scanFiles(project, tsFiles(project), /from\s*['"]@angular\/(animations|platform-browser\/animations)['"]/, 'Import from @angular/animations'),
};

const zoneless: Rule = {
  id: 'core/zoneless',
  hop: 'v21+',
  title: 'zone.js is optional — new apps are zoneless by default',
  since: 21,
  hint: 'Existing apps keep zone.js. To go zoneless: provideZonelessChangeDetection(), remove zone.js from polyfills, then fix places that relied on implicit change detection (signals or markForCheck).',
  check: ({ project }) => depFinding(project, 'zone.js', 'consider zoneless change detection.'),
};

const karma: Rule = {
  id: 'testing/karma',
  hop: 'v21+',
  title: 'Karma is deprecated; Vitest is the default test runner',
  since: 21,
  hint: 'ng g @schematics/angular:refactor-jasmine-vitest (experimental) or keep Karma until you are ready.',
  check: ({ project }) => depFinding(project, 'karma', 'Vitest is now the default.'),
};

// ---------------------------------------------------------------------------
// v22: explicit typing
// ---------------------------------------------------------------------------

const explicitTypes: Rule = {
  id: 'types/explicit-types',
  hop: 'v22',
  title: 'Declarations without explicit types',
  since: 22,
  hint: 'Run `ngx-upgrade-doctor types` — it shows what it would change and asks before writing. Use --mode implicit-any to only fix what noImplicitAny reports.',
  check({ project }) {
    const counts = collectUntyped(project);
    const total = counts.reduce((n, c) => n + c.count, 0);
    if (!total) return [];
    return [{ message: `${total} untyped parameters/variables/properties/return types in ${counts.length} file(s) — run \`ngx-upgrade-doctor types\`` }];
  },
};

export const modernRules: Rule[] = [
  flexLayout, classGuards, materialLegacy, mdcSelectors, nguniversal, controlFlow, standalone, applicationBuilder,
  httpClientModule, animationsPackage, zoneless, karma, explicitTypes,
];
