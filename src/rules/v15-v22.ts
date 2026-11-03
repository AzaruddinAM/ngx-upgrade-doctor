import * as semver from 'semver';
import { RawFinding, Rule } from './types';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  STYLES, TEMPLATES, countPerFile, depFinding, importSpecifiers, metadataArrays, nodeLine, scanFiles, sourceRoots, swapDep, transformFiles, tsFiles,
  configFiles, setJsonOption, JSON_OBJECT, tsconfigFiles, effectiveCompilerOptions, removeJsonProp, removeDeps, usesApplicationBuilder,
  buildTargets, buildGraph, deadCodeNote, addDevDep,
} from './helpers';
import { Project, lineOf } from '../project';
import { KNOWN_BREAKERS, REMOVALS, knownBreaker } from '../deps';
import { collectUntyped } from '../typer';
import { literalMatClasses, oldMaterialClasses, renameMdcClasses, styleSources, usesLegacyMaterial } from './mdc-design';

// ---------------------------------------------------------------------------
// v14 -> v17: Material moves to MDC
// ---------------------------------------------------------------------------

/** Swaps MatLegacy* symbols and legacy entry points for their MDC equivalents. */
export function migrateLegacyMaterialTs(text: string): string {
  if (!/@angular\/material\/legacy-|MatLegacy|MAT_LEGACY_/.test(text)) return text;
  return text
    .replace(/@angular\/material\/legacy-([\w-]+)/g, '@angular/material/$1')
    .replace(/\bgetMatLegacy(\w+)\s+as\s+(\w+)/g, (_w, rest: string, alias: string) => (alias === `getMat${rest}` ? alias : `getMat${rest} as ${alias}`))
    .replace(/\bgetMatLegacy(\w+)/g, 'getMat$1')
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
      ...leftoverLegacySymbols(project),
    ];
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), migrateLegacyMaterialTs);
    transformFiles(project, project.files('.scss'), migrateLegacyMaterialSass);
  },
};

const MDC_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@angular\/material\/(?!legacy-)[\w-]+['"]/g;

/** MatLegacy* / getMatLegacy* / MAT_LEGACY_* names imported from MDC entry points, which do not export them. */
function leftoverLegacySymbols(project: Project): RawFinding[] {
  const out: RawFinding[] = [];
  for (const file of tsFiles(project)) {
    const text = project.read(file);
    const re = new RegExp(MDC_IMPORT.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      for (const name of m[1].match(/\b(?:get)?MatLegacy\w+|\bMAT_LEGACY_\w+/g) || []) {
        const offset = m.index + m[0].indexOf(name);
        out.push({ file, line: lineOf(text, offset), message: `${name} is not exported by its MDC entry point → ${migrateLegacyMaterialTs(name)} (auto-fixable)` });
      }
    }
  }
  return out;
}

const mdcSelectors: Rule = {
  id: 'material/mdc-style-overrides',
  hop: 'v15-17',
  title: 'Style overrides target pre-MDC internal class names',
  since: 15,
  deprecatedIn: 15,
  fixRequires: 15,
  hint: 'MDC components use .mat-mdc-* / .mdc-* classes and a different DOM, so overrides of the old internal classes (.mat-form-field-infix, .mat-select-arrow-wrapper, .mat-option, .mat-button-wrapper, …) silently stop matching — the usual cause of misaligned fields, labels and dropdowns after an upgrade. The auto-fix renames them to their MDC counterparts (the mapping of the official mdc-migration schematic) in stylesheets and inline component styles; classes your own templates use literally are kept, and nothing is renamed while legacy (MatLegacy*) components are still imported. Classes with no 1:1 equivalent are listed for a hand rewrite. Re-check these screens visually afterwards: the MDC DOM differs, so paddings tuned for the old DOM may need adjusting; prefer the component tokens/mixins (e.g. mat.form-field-overrides in v18+). MDC buttons also contain a 48px .mat-mdc-button-touch-target: overflow-x: hidden on them turns overflow-y to auto, so every menu row grows its own scrollbar — use overflow: hidden and hide the touch target in dense menus.',
  check({ project }) {
    const legacy = usesLegacyMaterial(project);
    const keep = literalMatClasses(project);
    const out: RawFinding[] = [];
    for (const file of styleSources(project)) {
      const text = project.read(file);
      for (const u of oldMaterialClasses(text, file)) {
        const fixable = !!u.replacement && !legacy && !keep.has(u.name);
        out.push({
          file, line: lineOf(text, u.offset), fixable,
          message: u.replacement
            ? `Override of ${u.name} will no longer match → ${u.replacement}${keep.has(u.name) ? ' (kept: your templates use the class themselves)' : ''}`
            : `Override of ${u.name} will no longer match (no 1:1 MDC class — rewrite by hand)`,
        });
      }
    }
    for (const file of project.files(...STYLES)) {
      const text = project.read(file);
      for (const offset of mdcButtonOverflow(text)) {
        out.push({
          file, line: lineOf(text, offset), fixable: false,
          message: 'overflow-x: hidden/auto on an MDC button — overflow-y becomes auto and its 48px touch target adds a scrollbar; use overflow: hidden and .mat-mdc-button-touch-target { display: none }',
        });
      }
    }
    return out;
  },
  fix({ project }) {
    if (usesLegacyMaterial(project)) return;
    const keep = literalMatClasses(project);
    transformFiles(project, styleSources(project), (text, file) => renameMdcClasses(text, file, keep));
  },
};

/** Offsets of `overflow-x: hidden|auto` declarations in rules whose selector targets a Material button. */
export function mdcButtonOverflow(text: string): number[] {
  const out: number[] = [];
  const rule = /([^{};]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(text))) {
    if (!/mat-(mdc-)?(raised-|flat-|stroked-|icon-|unelevated-|outlined-)?button|mdc-button/.test(m[1])) continue;
    const decl = /overflow-x\s*:\s*(hidden|auto)/.exec(m[2]);
    if (decl) out.push(m.index + m[1].length + 1 + decl.index);
  }
  return out;
}

const FLEX_LAYOUT_IMPORT = /(['"])@angular\/flex-layout(\/[\w-]+)?\1/g;

/** Rewrites @angular/flex-layout (and its /flex, /extended, /core, /grid entry points) to @ngbracket/ngx-layout. */
export function migrateFlexLayoutImports(text: string): string {
  return text.replace(FLEX_LAYOUT_IMPORT, (_m, q: string, entry = '') => `${q}@ngbracket/ngx-layout${entry}${q}`);
}

const flexLayout: Rule = {
  id: 'deps/flex-layout',
  hop: 'v14-19',
  title: '@angular/flex-layout is unmaintained and crashes at runtime on Angular 19+',
  since: 15,
  deprecatedIn: 15,
  removedIn: 19,
  fixRequires: 15,
  hint: 'Its ngClass/ngStyle directives call the pre-v19 NgClass/NgStyle constructors ("this._renderer.addClass is not a function"); it compiles but fails at runtime. Drop-in fix: the maintained fork @ngbracket/ngx-layout@^<N> (same API, majors track Angular) — the auto-fix swaps the dependency and rewrites the imports; then npm install and clear .angular/cache. Long term: CSS flexbox/grid and BreakpointObserver from @angular/cdk/layout.',
  check({ project, version }) {
    const why = version >= 19 ? 'crashes at runtime on Angular 19+ (NgClass/NgStyle constructor changed)' : 'deprecated, no releases past 15';
    const out: RawFinding[] = depFinding(project, '@angular/flex-layout', `${why} → @ngbracket/ngx-layout@^${version}.0.0 (auto-fixable)`);
    // Imports left over after the package was swapped (e.g. by `deps --apply`).
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      if (!text.includes('@angular/flex-layout')) continue;
      for (const { specifier, offset } of importSpecifiers(text)) {
        if (/^@angular\/flex-layout(\/|$)/.test(specifier)) {
          out.push({ file, line: lineOf(text, offset), message: `import from '${specifier}' → '${migrateFlexLayoutImports(`'${specifier}'`).slice(1, -1)}' (auto-fixable)` });
        }
      }
    }
    return out;
  },
  fix({ project, version }) {
    if (project.declaredDeps['@angular/flex-layout']) swapDep(project, '@angular/flex-layout', '@ngbracket/ngx-layout', `^${version}.0.0`);
    transformFiles(project, tsFiles(project), migrateFlexLayoutImports);
  },
};

const knownIncompatible: Rule = {
  id: 'deps/known-incompatible',
  hop: 'v12-16',
  title: 'Library versions known to break the build on this Angular major',
  since: Math.min(...KNOWN_BREAKERS.map((b) => b.at)),
  removedIn: Math.min(...KNOWN_BREAKERS.map((b) => b.at)),
  hint: 'Run `ngx-upgrade-doctor deps` for the upgrade/replace commands. Most of these are View Engine libraries that ngcc patched until v16.',
  check({ project, version }) {
    return [...new Set(KNOWN_BREAKERS.map((b) => b.name))].map((name) => ({ name })).flatMap((b) => {
      const current = project.installedVersion(b.name) || project.declaredDeps[b.name];
      const hit = current && knownBreaker(b.name, current, version);
      return hit ? depFinding(project, b.name, `${hit.note} → ${hit.action === 'replace' ? 'replace with' : 'upgrade to'} ${hit.suggested}`) : [];
    });
  },
};

/** core-js/es/* (core-js 3), core-js/es6|es7/* (core-js 2) imports in polyfills files. */
const CORE_JS_ES_IMPORT = /^[ \t]*import\s*['"]core-js\/(es[67]?)\/[^'"]+['"]\s*;?[ \t]*(\/\/[^\n]*)?\r?\n?/gm;

function polyfillFiles(project: Project): string[] {
  return tsFiles(project).filter((f) => /(^|\/)polyfills[^/]*\.ts$/.test(f));
}

const coreJsPolyfills: Rule = {
  id: 'polyfills/core-js-unneeded',
  hop: 'v14-16',
  title: 'core-js language polyfills are unnecessary for the browsers Angular 15+ supports',
  since: 15,
  deprecatedIn: 15,
  fixRequires: 15,
  hint: 'Angular 15+ only supports evergreen browsers, and AOT needs no reflect-metadata. The auto-fix deletes the core-js/es* imports; afterwards `npm uninstall core-js` unless something else imports it.',
  check({ project }) {
    const coreJs = project.versionOf('core-js');
    const major = coreJs ? semver.major(coreJs) : undefined;
    return scanFiles(project, polyfillFiles(project), new RegExp(CORE_JS_ES_IMPORT.source, 'm'), (m) => {
      const broken = major === undefined
        ? ' — core-js is not installed, so the build fails'
        : (m[1] === 'es') !== (major >= 3) ? ` — core-js ${coreJs} has no ${m[1] === 'es' ? 'core-js/es/*' : `core-js/${m[1]}/*`} path, so the build fails` : '';
      return `core-js/${m[1]}/* polyfill import${broken} (auto-fixable)`;
    });
  },
  fix({ project }) {
    transformFiles(project, polyfillFiles(project), (text) => text.replace(CORE_JS_ES_IMPORT, ''));
  },
};

export interface PositionalThemeCall {
  offset: number;
  /** Offset just past the closing parenthesis. */
  end: number;
  /** Sass namespace the call is made through (`mat`, or whatever `@use ... as` named it). */
  ns: string;
  /** `m2-` for the v18+ names, '' for the v15-17 ones. */
  prefix: string;
  /** `define-light-theme` or `define-dark-theme`. */
  fn: string;
  args: string[];
  /** Plain 2-3 argument form that the auto-fix can rewrite to a config map. */
  fixable: boolean;
}

/**
 * `<ns>.define-light-theme($primary, $accent[, $warn])` and the v18 `<ns>.m2-define-*-theme` forms:
 * two or more positional arguments instead of a config map.
 */
export function positionalThemeCalls(text: string): PositionalThemeCall[] {
  const out: PositionalThemeCall[] = [];
  const re = /(?<![\w$-])([\w-]+)\.(m2-)?(define-(?:light|dark)-theme)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    const args: string[] = [];
    const start = m.index + m[0].length;
    let argStart = start;
    let i = start;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push(text.slice(argStart, i).trim());
        argStart = i + 1;
      }
    }
    const last = text.slice(argStart, i).trim();
    if (last) args.push(last);
    if (args.length < 2 || args[0].startsWith('(')) continue;
    // Keyword arguments ($primary: ...) or splats need a human.
    const fixable = args.length <= 3 && args.every((a) => a && !/^\$[\w-]+\s*:|\.\.\.$/.test(a));
    out.push({ offset: m.index, end: i + 1, ns: m[1], prefix: m[2] || '', fn: m[3], args, fixable });
  }
  return out;
}

/** Rewrites plain positional theme calls to the equivalent config map (same CSS output). */
export function migrateThemePositional(text: string): string {
  const calls = positionalThemeCalls(text).filter((c) => c.fixable);
  for (const c of calls.reverse()) {
    const color = ['primary', 'accent', 'warn'].slice(0, c.args.length).map((k, i) => `${k}: ${c.args[i]}`).join(', ');
    const call = `${c.ns}.${c.prefix}${c.fn}((color: (${color}), typography: ${c.ns}.${c.prefix}define-typography-config(), density: 0))`;
    text = text.slice(0, c.offset) + call + text.slice(c.end);
  }
  return text;
}

const themePositional: Rule = {
  id: 'material/theme-positional-palettes',
  hop: 'v14-15',
  title: 'define-light-theme/define-dark-theme (m2-define-* in v18+) with positional palettes',
  since: 15,
  deprecatedIn: 15,
  fixRequires: 15,
  hint: 'Pass a config map. v15-17: mat.define-light-theme((color: (primary: $primary, accent: $accent, warn: $warn), typography: mat.define-typography-config(), density: 0)); v18+: mat.m2-define-light-theme((color: (...), typography: mat.m2-define-typography-config(), density: 0)). The auto-fix rewrites plain 2-3 argument calls exactly like that.',
  docs: 'https://v15.material.angular.io/guide/theming#defining-a-theme',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files('.scss')) {
      const text = project.read(file);
      for (const call of positionalThemeCalls(text)) {
        out.push({
          file, line: lineOf(text, call.offset), fixable: call.fixable,
          message: `${call.ns}.${call.prefix}${call.fn}() with positional palettes — pass a (color: (...), typography: ..., density: ...) map${call.fixable ? ' (auto-fixable)' : ' (manual)'}`,
        });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, project.files('.scss'), migrateThemePositional);
  },
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
  check({ project }) {
    // Only entries of metadata `imports` arrays — not the `import { HttpClientModule } from ...` statement.
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      if (!/HttpClient(Testing)?Module/.test(text)) continue;
      for (const arr of metadataArrays(file, text).filter((a) => a.prop === 'imports')) {
        for (const el of arr.elements) {
          if (ts.isIdentifier(el) && /^HttpClient(Testing)?Module$/.test(el.text)) {
            out.push({ file, line: nodeLine(el, arr.source), message: `${el.text} in ${ownerLabel(arr.owner)} imports` });
          }
        }
      }
    }
    return out;
  },
};

function ownerLabel(owner: string): string {
  return owner === 'configureTestingModule' ? 'TestBed.configureTestingModule' : `@${owner}`;
}

/** Entries listed more than once in the same metadata array; the first occurrence of each is kept. */
export function duplicateMetadataEntries(file: string, text: string): Array<{ name: string; count: number; owner: string; prop: string; line: number; remove: Array<[number, number]> }> {
  const out: ReturnType<typeof duplicateMetadataEntries> = [];
  for (const arr of metadataArrays(file, text)) {
    if (!/^(imports|declarations|providers|exports|entryComponents|bootstrap)$/.test(arr.prop)) continue;
    const seen = new Map<string, number[]>();
    arr.elements.forEach((el, i) => {
      // Identifiers and A.B references only: two forRoot()/forChild() calls are different entries.
      if (!ts.isIdentifier(el) && !ts.isPropertyAccessExpression(el)) return;
      const key = el.getText(arr.source).replace(/\s+/g, '');
      seen.set(key, [...(seen.get(key) || []), i]);
    });
    for (const [name, idx] of seen) {
      if (idx.length < 2) continue;
      // Remove ", Dup" — from the end of the previous element to the end of the duplicate.
      const remove = idx.slice(1).map((i): [number, number] => [arr.elements[i - 1].getEnd(), arr.elements[i].getEnd()]);
      out.push({ name, count: idx.length, owner: arr.owner, prop: arr.prop, line: nodeLine(arr.elements[idx[1]], arr.source), remove });
    }
  }
  return out;
}

const duplicateMetadata: Rule = {
  id: 'core/duplicate-metadata-entries',
  hop: 'v17-18',
  title: 'The same entry is listed twice in an NgModule/Component metadata array',
  since: 6,
  deprecatedIn: 18,
  hint: 'Harmless to Angular itself, but the v18 "replace deprecated HTTP modules with provider functions" migration removes the import statement and only ONE HttpClientModule entry, leaving a dangling reference (TS2304). The auto-fix keeps the first occurrence.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      if (!/@(NgModule|Component|Directive|Pipe)\b|configureTestingModule/.test(text)) continue;
      for (const d of duplicateMetadataEntries(file, text)) {
        const why = d.name === 'HttpClientModule' ? ' — the v18 HTTP migration leaves a dangling reference' : '';
        out.push({ file, line: d.line, message: `${d.name} listed ${d.count} times in ${ownerLabel(d.owner)} ${d.prop}${why} (auto-fixable)` });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text, file) => {
      const ranges = duplicateMetadataEntries(file, text).flatMap((d) => d.remove).sort((a, b) => b[0] - a[0]);
      for (const [from, to] of ranges) text = text.slice(0, from) + text.slice(to);
      return text;
    });
  },
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
// v18 -> v19: template <style> urls, Sass module system
// ---------------------------------------------------------------------------

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const CSS_URL = /\burl\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
/** URLs the CLI leaves alone: absolute, protocol, data:, fragment, `~` module or `^` "keep as is". */
const KEEP_URL = /^(\/|~|\^|#|[a-z][a-z\d+.-]*:)/i;

export interface TemplateStyleUrl {
  /** Offset of the URL text (inside the quotes, if any). */
  offset: number;
  url: string;
}

/** Relative url() values inside <style> blocks of a template (HTML file or inline template). */
export function templateStyleUrls(text: string): TemplateStyleUrl[] {
  const out: TemplateStyleUrl[] = [];
  const blocks = new RegExp(STYLE_BLOCK.source, 'gi');
  let b: RegExpExecArray | null;
  while ((b = blocks.exec(text))) {
    const bodyStart = b.index + b[0].indexOf('>') + 1;
    const urls = new RegExp(CSS_URL.source, 'g');
    let u: RegExpExecArray | null;
    while ((u = urls.exec(b[1]))) {
      const url = u[2];
      // Interpolated ({{ }}) or Sass-like values are left to a human.
      if (KEEP_URL.test(url) || /[{}$]/.test(url)) continue;
      out.push({ offset: bodyStart + u.index + u[0].indexOf(url, 4), url });
    }
  }
  return out;
}

/** Prefixes `^` so the CLI leaves the URL untouched: same runtime behaviour, also under a sub-path <base href>. */
export function keepTemplateStyleUrls(text: string): string {
  for (const u of templateStyleUrls(text).reverse()) text = `${text.slice(0, u.offset)}^${text.slice(u.offset)}`;
  return text;
}

/** Templates: .html files and component .ts files with an inline <style> block. */
function templateFiles(project: Project): string[] {
  return [...project.files(...TEMPLATES), ...tsFiles(project).filter((f) => /<style\b/i.test(project.read(f)))];
}

/** Where a url() really points: the component folder, a source root or the workspace root. */
function assetPath(project: Project, file: string, url: string): string | undefined {
  const clean = url.replace(/[?#].*$/, '');
  const dirs = [path.posix.dirname(file), ...sourceRoots(project), ''];
  return dirs.map((d) => path.posix.normalize(path.posix.join(d, clean))).find((p) => !p.startsWith('..') && project.exists(p));
}

/** Template <style> url()s that do not resolve from the component's own folder (those that do are fine on every builder). */
function unresolvedStyleUrls(project: Project, file: string, text: string): TemplateStyleUrl[] {
  return templateStyleUrls(text).filter((u) => !project.exists(path.posix.normalize(path.posix.join(path.posix.dirname(file), u.url.replace(/[?#].*$/, '')))));
}

function assetExists(project: Project, file: string, url: string): boolean {
  return !!assetPath(project, file, url);
}

/** `url('^x')` (webpack's "leave as is" prefix) in a stylesheet, or in <style> blocks of a template. */
export function caretStyleUrls(text: string, template: boolean): TemplateStyleUrl[] {
  const out: TemplateStyleUrl[] = [];
  const scan = (body: string, base: number): void => {
    const urls = new RegExp(CSS_URL.source, 'g');
    let u: RegExpExecArray | null;
    while ((u = urls.exec(body))) {
      if (u[2].startsWith('^')) out.push({ offset: base + u.index + u[0].indexOf(u[2], 4), url: u[2].slice(1) });
    }
  };
  if (!template) {
    scan(text, 0);
    return out;
  }
  const blocks = new RegExp(STYLE_BLOCK.source, 'gi');
  let b: RegExpExecArray | null;
  while ((b = blocks.exec(text))) scan(b[1], b.index + b[0].indexOf('>') + 1);
  return out;
}

/** Removes the CSS declaration (`prop: ...;`) containing `offset`. */
function removeDeclaration(text: string, offset: number): string {
  const start = Math.max(text.lastIndexOf(';', offset), text.lastIndexOf('{', offset)) + 1;
  const semi = text.indexOf(';', offset);
  const brace = text.indexOf('}', offset);
  const end = semi >= 0 && (brace < 0 || semi < brace) ? semi + 1 : brace >= 0 ? brace : text.length;
  return text.slice(0, start) + text.slice(end);
}

/**
 * For the esbuild application builder, which resolves url() at build time and knows no `^`: point each
 * URL at the real file, relative to the component/stylesheet, or drop the declaration when the file does
 * not exist (it was already a 404).
 */
export function esbuildStyleUrlFix(project: Project, file: string, text: string, urls: TemplateStyleUrl[]): string {
  for (const u of [...urls].sort((a, b) => b.offset - a.offset)) {
    const hasCaret = text[u.offset] === '^';
    const found = assetPath(project, file, u.url);
    if (found) {
      let rel = path.posix.relative(path.posix.dirname(file), found);
      if (!rel.startsWith('.')) rel = `./${rel}`;
      text = text.slice(0, u.offset) + rel + text.slice(u.offset + u.url.length + (hasCaret ? 1 : 0));
    } else {
      text = removeDeclaration(text, u.offset);
    }
  }
  return text;
}

function styleFiles(project: Project): string[] {
  return project.files('.scss', '.css', '.sass', '.less');
}

const templateStyleUrl: Rule = {
  id: 'template/style-relative-url',
  hop: 'v18+',
  title: 'url() values the stylesheet pipeline cannot resolve (template <style> blocks, `^` URLs)',
  since: 19,
  removedIn: 19,
  fixRequires: 19,
  hint: "Angular 19 runs template <style> blocks through the stylesheet pipeline, so url('assets/x.png') must resolve from the component folder (\"Can't resolve ...\"). Webpack builder: the auto-fix prefixes ^ (url('^assets/x.png')) so the URL is left as is. esbuild application builder: ^ is unknown (\"Could not resolve '^assets/...' [plugin angular-css-resource]\"), so the auto-fix points the URL at the real file relative to the component, and drops declarations whose file does not exist (they were 404s already). Changing to /assets/... would break deployments under a sub-path <base href>.",
  check({ project }) {
    const esbuild = usesApplicationBuilder(project);
    const out: RawFinding[] = [];
    for (const file of templateFiles(project)) {
      const text = project.read(file);
      if (!/<style\b/i.test(text)) continue;
      for (const u of unresolvedStyleUrls(project, file, text)) {
        const found = assetPath(project, file, u.url);
        const missing = found ? '' : ' (file not found in the component folder or src — already broken at runtime)';
        const action = !esbuild ? '' : found ? ` → '${esbuildStyleUrlFix(project, file, `url(${u.url})`, [{ offset: 4, url: u.url }]).slice(4, -1)}'` : ' → declaration removed';
        out.push({ file, line: lineOf(text, u.offset), message: `url(${u.url}) in a <style> block${missing}${action} (auto-fixable)` });
      }
    }
    for (const file of [...templateFiles(project), ...styleFiles(project)]) {
      const text = project.read(file);
      if (!text.includes('^')) continue;
      for (const u of caretStyleUrls(text, !styleFiles(project).includes(file))) {
        out.push(esbuild
          ? { file, line: lineOf(text, u.offset), message: `url(^${u.url}): the esbuild application builder does not support the ^ prefix (Could not resolve) → ${assetExists(project, file, u.url) ? 'relative path' : 'declaration removed (file not found)'} (auto-fixable)` }
          : { file, line: lineOf(text, u.offset), severity: 'warning', fixable: false, message: `url(^${u.url}) only works with the webpack builder — the use-application-builder migration breaks it; rerun the fix after switching builders` });
      }
    }
    return out;
  },
  fix({ project }) {
    if (!usesApplicationBuilder(project)) {
      transformFiles(project, templateFiles(project), (text, file) => {
        for (const u of unresolvedStyleUrls(project, file, text).reverse()) text = `${text.slice(0, u.offset)}^${text.slice(u.offset)}`;
        return text;
      });
      return;
    }
    const styles = styleFiles(project);
    transformFiles(project, [...templateFiles(project), ...styles], (text, file) => {
      const template = !styles.includes(file);
      const urls = [...(template && /<style\b/i.test(text) ? unresolvedStyleUrls(project, file, text) : []), ...caretStyleUrls(text, template)];
      return urls.length ? esbuildStyleUrlFix(project, file, text, urls) : text;
    });
  },
};

const SASS_GLOBAL_FUNCTIONS = [
  'map-get', 'map-merge', 'map-has-key', 'map-keys', 'map-values', 'map-remove', 'map-deep-merge',
  'darken', 'lighten', 'saturate', 'desaturate', 'adjust-hue', 'transparentize', 'opacify', 'fade-in', 'fade-out',
  'mix', 'adjust-color', 'scale-color', 'change-color', 'complement', 'grayscale', 'invert',
  'nth', 'set-nth', 'length', 'append', 'join', 'index', 'zip', 'list-separator',
  'unquote', 'quote', 'str-index', 'str-slice', 'str-insert', 'str-length', 'to-upper-case', 'to-lower-case',
  'percentage', 'unit', 'unitless', 'comparable', 'type-of', 'unique-id', 'random', 'floor', 'ceil',
  // Color channels ("blue() is deprecated. Suggestion: color.channel(...)").
  'red', 'green', 'blue', 'hue', 'saturation', 'lightness', 'whiteness', 'blackness', 'alpha', 'opacity', 'ie-hex-str',
  'is-bracketed', 'keywords', 'inspect', 'feature-exists', 'variable-exists', 'global-variable-exists',
  'function-exists', 'mixin-exists', 'content-exists', 'get-function', 'call',
  'selector-nest', 'selector-append', 'selector-extend', 'selector-replace', 'selector-unify', 'selector-parse',
  'is-superselector', 'simple-selectors',
];
const SASS_GLOBAL_CALL = new RegExp(`(?<![\\w.$@%-])(${SASS_GLOBAL_FUNCTIONS.join('|')})\\(`, 'g');
/** Also plain CSS functions (filter: opacity(50%), IE alpha(opacity=50)): only Sass when given a color. */
const CSS_OVERLOADED = new Set(['opacity', 'invert', 'grayscale', 'saturate', 'alpha']);
/** Sass @import rules; plain CSS imports (url(), .css, http) are not deprecated. */
const SASS_IMPORT = /^[ \t]*@import\s+(?!url\(|['"][^'"]+\.css['"]|['"]https?:)/gm;

/** Deprecated Sass constructs in one stylesheet, ignoring comments and plain CSS uses of the same names. */
export function sassDeprecations(text: string): { imports: number; globals: number; names: string[] } {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const names = new Set<string>();
  let globals = 0;
  const re = new RegExp(SASS_GLOBAL_CALL.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const before = code.slice(lineStart, m.index);
    // A user-defined @function/@mixin with the same name, or a CSS filter value.
    if (/@(function|mixin|include)\s+$/.test(before) || /(^|[\s;{])(-webkit-)?(backdrop-)?filter\s*:[^;{}]*$/.test(before)) continue;
    if (CSS_OVERLOADED.has(m[1])) {
      const arg = code.slice(m.index + m[0].length).split(/[,)]/)[0].trim();
      if (!arg || /=|^[\d.]+%?$/.test(arg)) continue;
    }
    globals++;
    names.add(m[1]);
  }
  return { imports: (code.match(SASS_IMPORT) || []).length, globals, names: [...names] };
}

const sassModuleSystem: Rule = {
  id: 'sass/module-system',
  hop: 'v18+',
  title: 'Sass @import and global built-in functions are deprecated (Dart Sass 3 removes them)',
  since: 19,
  deprecatedIn: 19,
  hint: "Not a blocker — the build only prints deprecation warnings. Migrate with `npx sass-migrator module --migrate-deps src/styles.scss` (@import → @use/@forward, map-get → map.get with @use 'sass:map', darken → color.adjust, ...).",
  docs: 'https://sass-lang.com/documentation/breaking-changes/import/',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files('.scss', '.sass')) {
      const d = sassDeprecations(project.read(file));
      if (!d.imports && !d.globals) continue;
      const parts = [
        d.imports ? `${d.imports} @import rule(s)` : '',
        d.globals ? `${d.globals} global built-in call(s) (${d.names.slice(0, 4).join(', ')}${d.names.length > 4 ? ', ...' : ''})` : '',
      ].filter(Boolean);
      out.push({ file, message: parts.join(', ') });
    }
    return out;
  },
};

/** Constructor arity of the common directives libraries wrap, as of Angular 19. */
const COMMON_DIRECTIVE_ARITY: Record<string, number> = { NgClass: 2, NgStyle: 3 };

/** `new NgClass(...)` / `new NgStyle(...)` calls and their argument counts. */
export function commonDirectiveConstructions(text: string): Array<{ cls: string; args: number; offset: number }> {
  const out: Array<{ cls: string; args: number; offset: number }> = [];
  const re = /\bnew\s+(?:[\w$]+\.)?(NgClass|NgStyle)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    let args = 0;
    let any = false;
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) args++;
      if (!/\s/.test(c)) any = true;
    }
    out.push({ cls: m[1], args: any ? args + 1 : 0, offset: m.index });
  }
  return out;
}

/** Library JS files to inspect: .mjs/.js below node_modules/<name>, without nested node_modules. */
function libraryFiles(dir: string, limit = 2000): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (/\.m?js$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const commonDirectiveConstructors: Rule = {
  id: 'deps/common-directive-constructors',
  hop: 'v18-19',
  title: 'Libraries that construct NgClass/NgStyle with the pre-v19 constructor (runtime crash)',
  since: 19,
  removedIn: 19,
  hint: 'Angular 19 changed the NgClass (ngEl, renderer) and NgStyle (ngEl, differs, renderer) constructors. A library that still calls the old ones compiles fine but fails at runtime ("this._renderer.addClass is not a function"). Upgrade or replace it (run `ngx-upgrade-doctor deps --online`).',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const name of Object.keys(project.declaredDeps)) {
      if (name.startsWith('@angular/')) continue;
      const dir = path.join(project.root, 'node_modules', name);
      if (!fs.existsSync(dir)) continue;
      for (const file of libraryFiles(dir)) {
        let text: string;
        try {
          if (fs.statSync(file).size > 3_000_000) continue;
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (!/new\s+(?:[\w$]+\.)?Ng(Class|Style)\b/.test(text)) continue;
        const bad = commonDirectiveConstructions(text).find((c) => c.args !== COMMON_DIRECTIVE_ARITY[c.cls]);
        if (!bad) continue;
        const rel = path.relative(dir, file).replace(/\\/g, '/');
        out.push({
          file: 'package.json',
          message: `${name}@${project.installedVersion(name)}: new ${bad.cls}(…${bad.args} args) in ${rel}:${lineOf(text, bad.offset)} — Angular 19 expects ${COMMON_DIRECTIVE_ARITY[bad.cls]}`,
        });
        break;
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// v20 -> v21: automatic control-flow migration, TS 5.9 BufferSource
// ---------------------------------------------------------------------------

const STRUCTURAL = /\*ng(If|For|Switch(Case|Default)?)\b/g;

/** HTML templates plus component .ts files with an inline `template:`. */
function templateSources(project: Project): string[] {
  return [...project.files(...TEMPLATES), ...tsFiles(project).filter((f) => /\btemplate\s*:/.test(project.read(f)))];
}

const controlFlowAutoMigration: Rule = {
  id: 'template/control-flow-auto-migration',
  hop: 'v20-21',
  title: 'ng update to v21 rewrites every structural directive to @if/@for/@switch',
  since: 21,
  until: 21,
  level: 'warning',
  hint: 'The v21 core update runs the control-flow migration automatically — it is not optional, can take many minutes on a big app, and leaves template parse errors where an expression was sloppy (fix template/structural-trailing-separator and template/invalid-html first). Commit before `ng update`, then review the template diff.',
  check({ project }) {
    let total = 0;
    let files = 0;
    for (const file of templateSources(project)) {
      const n = (project.read(file).match(STRUCTURAL) || []).length;
      if (n) {
        total += n;
        files++;
      }
    }
    return total ? [{ message: `ng update will rewrite ${total} *ngIf/*ngFor/*ngSwitch in ${files} template file(s); review the diff` }] : [];
  },
};

/** `*ngIf="cond,"` / `*ngFor="let x of xs;"`: microsyntax ignores the trailing separator, @if/@for do not. */
const TRAILING_SEPARATOR = /(\*ng(?:If|For|SwitchCase)\s*=\s*)(["'])([^"']*?)\s*[,;][\s,;]*\2/g;

export function stripStructuralTrailingSeparators(text: string): string {
  return text.replace(TRAILING_SEPARATOR, (_m, head: string, q: string, expr: string) => `${head}${q}${expr}${q}`);
}

const structuralTrailingSeparator: Rule = {
  id: 'template/structural-trailing-separator',
  hop: 'v20-21',
  title: 'Structural directive value ending in "," or ";" (breaks the control-flow migration)',
  since: 17,
  deprecatedIn: 17,
  removedIn: 21,
  hint: 'The control-flow migration copies the expression as is: *ngIf="a && b," becomes @if (a && b,) { and the build fails with NG5002 "Unexpected token \',\'". The auto-fix drops the trailing separator — no behaviour change.',
  check({ project }) {
    return scanFiles(project, templateSources(project), new RegExp(TRAILING_SEPARATOR.source),
      (m) => `${m[1].replace(/\s*=\s*$/, '')} value "${m[3].trim()}" ends with "," or ";" (auto-fixable)`);
  },
  fix({ project }) {
    transformFiles(project, templateSources(project), stripStructuralTrailingSeparators);
  },
};

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose end tag HTML lets you omit (the parser closes them implicitly). */
const OPTIONAL_END = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'option', 'optgroup', 'thead', 'tbody', 'tfoot', 'colgroup', 'rp', 'rt']);

export interface TagProblem {
  line: number;
  message: string;
}

/**
 * First unbalanced or mis-nested element in an HTML template, from a small tag scanner that skips
 * comments, {{ }} interpolations, quoted attribute values and <script>/<style> contents.
 */
export function templateTagProblem(text: string): TagProblem | undefined {
  const stack: Array<{ name: string; line: number }> = [];
  let line = 1;
  let i = 0;
  const advance = (to: number): void => {
    for (; i < to; i++) if (text.charCodeAt(i) === 10) line++;
  };
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      advance(end < 0 ? text.length : end + 3);
      continue;
    }
    if (text.startsWith('{{', i)) {
      const end = text.indexOf('}}', i + 2);
      advance(end < 0 ? text.length : end + 2);
      continue;
    }
    const open = /^<([a-zA-Z][\w:.-]*)/.exec(text.slice(i, i + 200));
    const close = /^<\/([a-zA-Z][\w:.-]*)\s*>/.exec(text.slice(i, i + 200));
    if (open) {
      const name = open[1].toLowerCase();
      const startLine = line;
      // Find the end of the start tag, skipping quoted attribute values.
      let j = i + open[0].length;
      let quote = '';
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const selfClosing = text[j - 1] === '/';
      advance(j + 1);
      if (selfClosing || VOID_ELEMENTS.has(name)) continue;
      if (name === 'script' || name === 'style') {
        // Skip the raw content and its end tag.
        const end = text.toLowerCase().indexOf(`</${name}`, i);
        const gt = end < 0 ? -1 : text.indexOf('>', end);
        advance(gt < 0 ? text.length : gt + 1);
        continue;
      }
      // A new <li>/<p>/<td>... implicitly closes an open one of the same kind.
      if (OPTIONAL_END.has(name) && stack.length && stack[stack.length - 1].name === name) stack.pop();
      stack.push({ name, line: startLine });
      continue;
    }
    if (close) {
      const name = close[1].toLowerCase();
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at < 0) {
        if (!VOID_ELEMENTS.has(name)) return { line, message: `</${name}> has no matching <${name}>` };
      } else {
        const unclosed = stack.slice(at + 1).find((e) => !OPTIONAL_END.has(e.name));
        if (unclosed) return { line: unclosed.line, message: `<${unclosed.name}> is not closed before </${name}> (line ${line})` };
        stack.length = at;
      }
      advance(i + close[0].length);
      continue;
    }
    advance(i + 1);
  }
  const left = stack.find((e) => !OPTIONAL_END.has(e.name));
  return left ? { line: left.line, message: `<${left.name}> is never closed` } : undefined;
}

/** `fxLayout="column"*ngIf="x"` / `*ngIf="x"style="..."`: a structural directive glued to a neighbouring attribute. */
const GLUED_BEFORE = /(["'])(?=\*ng[A-Za-z])/g;
const GLUED_AFTER = /(\*ng[A-Za-z]+\s*=\s*(["'])[^"']*\2)(?=[^\s>/])/g;

/** Inserts the missing space around structural directives glued to another attribute. */
export function separateGluedDirectives(text: string): string {
  return text.replace(GLUED_BEFORE, '$1 ').replace(GLUED_AFTER, '$1 ');
}

const invalidTemplateHtml: Rule = {
  id: 'template/invalid-html',
  hop: 'v17+',
  title: 'Templates the control-flow migration rejects as invalid HTML',
  since: 17,
  deprecatedIn: 21,
  hint: 'The control-flow migration refuses templates it cannot re-parse ("The migration resulted in invalid HTML") and leaves their *ngIf/*ngFor in place. Two causes: a structural directive written against another attribute with no space (*ngIf="a"style="..."; auto-fixable), and unbalanced/mis-nested tags (fix by hand at the reported line). Then re-run `ng g @angular/core:control-flow`.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files(...TEMPLATES)) {
      const text = project.read(file);
      for (const re of [GLUED_BEFORE, GLUED_AFTER]) {
        for (const f of scanFiles(project, [file], new RegExp(re.source), 'structural directive glued to another attribute — no space between them (auto-fixable)')) out.push(f);
      }
      const problem = templateTagProblem(text);
      if (problem) out.push({ file, line: problem.line, message: problem.message, fixable: false });
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, project.files(...TEMPLATES), separateGluedDirectives);
  },
};

/** APIs whose parameters are BufferSource (= ArrayBufferView<ArrayBuffer> in TS 5.9's lib.dom). */
/** APIs typed BufferSource. TextDecoder.decode takes AllowSharedBufferSource, so any Uint8Array still fits there. */
const BUFFER_SOURCE_API = /\bcrypto\.subtle\.|\bsubtle\.(encrypt|decrypt|importKey|digest|sign|verify|deriveKey|deriveBits|wrapKey|unwrapKey)\b|\b(iv|salt|counter|additionalData)\s*:/;

/**
 * `Uint8Array` used as a type without a type argument (TS 5.7+ reads it as Uint8Array<ArrayBufferLike>).
 * With `includeParameters: false`, only return/property/variable types — where the value is produced;
 * narrowing a parameter would move the error to callers that pass a plain Uint8Array.
 */
export function bareUint8ArrayTypes(file: string, text: string, includeParameters = true): ts.TypeReferenceNode[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: ts.TypeReferenceNode[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Uint8Array' && !node.typeArguments
      && (includeParameters || !ts.isParameter(node.parent))) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function bufferSourceFiles(project: Project): string[] {
  return tsFiles(project).filter((f) => {
    const text = project.read(f);
    return /\bUint8Array\b/.test(text) && BUFFER_SOURCE_API.test(text);
  });
}

const uint8ArrayBufferSource: Rule = {
  id: 'types/uint8array-buffer-source',
  hop: 'v21+',
  title: 'Uint8Array types passed to Web Crypto (TS2322 with TypeScript 5.9)',
  since: 21,
  removedIn: 21,
  fixRequires: 20,
  hint: "TS 5.7 made Uint8Array generic (Uint8Array<ArrayBufferLike>) and TS 5.9's lib.dom requires ArrayBufferView<ArrayBuffer> for BufferSource, so a value typed `Uint8Array` no longer fits crypto.subtle.encrypt/decrypt/importKey/digest or iv:/salt: params (TextDecoder.decode and array methods still accept it). The auto-fix annotates those types as Uint8Array<ArrayBuffer> (no runtime change) in files that call these APIs; it needs TypeScript 5.7+ (Angular 20 ships 5.8). Skipped once TypeScript 5.9 is installed — then `current --tsc` is exact.",
  check({ project }) {
    const out: RawFinding[] = [];
    // Once TypeScript 5.9 is installed the compiler is the source of truth (`current --tsc`).
    const installed = project.versionOf('typescript');
    if (installed && semver.gte(semver.coerce(installed) || '0.0.0', '5.9.0')) return out;
    for (const file of bufferSourceFiles(project)) {
      const text = project.read(file);
      for (const node of bareUint8ArrayTypes(file, text)) {
        const param = ts.isParameter(node.parent);
        out.push({
          // Only a problem if the parameter reaches a BufferSource API, which this check cannot tell.
          file, line: lineOf(text, node.getStart()), fixable: !param, ...(param ? { severity: 'warning' as const } : {}),
          message: param
            ? 'Uint8Array parameter in a file using BufferSource APIs — if it reaches crypto.subtle, type it Uint8Array<ArrayBuffer> and check the callers (manual)'
            : 'Uint8Array type in a file using BufferSource APIs → Uint8Array<ArrayBuffer> (auto-fixable)',
        });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, bufferSourceFiles(project), (text, file) => {
      for (const node of bareUint8ArrayTypes(file, text, false).reverse()) {
        text = `${text.slice(0, node.getEnd())}<ArrayBuffer>${text.slice(node.getEnd())}`;
      }
      return text;
    });
  },
};

// Relative router links that climb above the root: clamped to "/" up to v20, NG04005 from v21.
const LINK_PATTERNS: Array<{ re: RegExp; form: string; group: number }> = [
  // routerLink="../a" / routerLink='../a'
  { re: /(?<![\w.[-])routerLink\s*=\s*(["'])((?:\.\.\/)+[^"']*)\1/g, form: 'routerLink', group: 2 },
  // [routerLink]="'../a'" / [routerLink]="['../a', id]"
  { re: /\[routerLink\]\s*=\s*(["'])\s*\[?\s*(["'])((?:\.\.\/)+[^"']*)\2/g, form: '[routerLink]', group: 3 },
  // router.navigate(['../a'], ...) / router.createUrlTree(['../a'])
  { re: /\.(?:navigate|createUrlTree)\(\s*\[\s*(['"`])((?:\.\.\/)+[^'"`]*)\1/g, form: 'navigate', group: 2 },
  // router.navigateByUrl('../a')
  { re: /\.navigateByUrl\(\s*(['"`])((?:\.\.\/)+[^'"`]*)\1/g, form: 'navigateByUrl', group: 2 },
];
/** [routerLink] bound to data (menu.routerLink, item.url): cannot be checked statically. */
const DYNAMIC_ROUTER_LINK = /\[routerLink\]\s*=\s*(["'])(?!\s*\[?\s*["'])/g;
const SHARED_CHROME = /(header|menu|sidenav|sidebar|side-nav|toolbar|navbar|nav-bar|topbar|top-bar|footer|breadcrumb)/i;

export interface RelativeLink {
  /** Offset of the path text. */
  offset: number;
  path: string;
  form: string;
  /** navigate()/createUrlTree() call that passes relativeTo. */
  relativeTo: boolean;
}

/** `../` router links and navigate() commands in a template or component file. */
export function relativeRouterLinks(text: string): RelativeLink[] {
  const out: RelativeLink[] = [];
  for (const { re, form, group } of LINK_PATTERNS) {
    const g = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      const path = m[group];
      const offset = m.index + m[0].lastIndexOf(path);
      // relativeTo must be in the same call; look ahead to the end of the statement.
      const rest = text.slice(m.index, m.index + 400).split(/;\s*$|;\n/m)[0];
      out.push({ offset, path, form, relativeTo: form === 'navigate' && /\brelativeTo\s*:/.test(rest) });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Replaces leading `../` segments with `/` — what the router produced before v21. */
export function clampRelativeLinks(text: string, links = relativeRouterLinks(text)): string {
  for (const l of [...links].sort((a, b) => b.offset - a.offset)) {
    const ups = /^(?:\.\.\/)+/.exec(l.path)![0].length;
    text = text.slice(0, l.offset) + '/' + text.slice(l.offset + ups);
  }
  return text;
}

interface RouteIndex {
  /** Components used as a route `component:` anywhere. */
  targets: Set<string>;
  /** Components of routes at path '' or '**'. */
  rootTargets: Set<string>;
}

function routeIndex(project: Project): RouteIndex {
  const targets = new Set<string>();
  const rootTargets = new Set<string>();
  for (const file of tsFiles(project)) {
    const text = project.read(file);
    if (!/\bcomponent\s*:/.test(text)) continue;
    const re = /\{[^{}]*\bcomponent\s*:\s*(\w+)[^{}]*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      targets.add(m[1]);
      if (/\bpath\s*:\s*(['"`])(\*\*)?\1/.test(m[0])) rootTargets.add(m[1]);
    }
  }
  return { targets, rootTargets };
}

/** Why a relative link in this file climbs above the root, or undefined when only the route depth can tell. */
function aboveRootReason(project: Project, file: string, text: string, routes: RouteIndex): string | undefined {
  if (/<router-outlet\b/.test(text)) return 'layout component (has <router-outlet>)';
  const tsFile = file.endsWith('.html') ? file.replace(/\.html$/, '.ts') : file;
  const ts = project.exists(tsFile) ? project.read(tsFile) : '';
  const cls = (/export\s+class\s+(\w+)/.exec(ts) || [])[1];
  if (cls && routes.rootTargets.has(cls)) return `${cls} is the component of a '' or '**' route`;
  if ((!cls || !routes.targets.has(cls)) && SHARED_CHROME.test(file.split('/').pop() || '')) return 'shared header/menu component, not a route target';
  return undefined;
}

function routerLinkFiles(project: Project): string[] {
  return [...project.files(...TEMPLATES), ...tsFiles(project)].filter((f) => /\.\.\/|\[routerLink\]/.test(project.read(f)));
}

const relativeLinksAboveRoot: Rule = {
  id: 'router/relative-link-above-root',
  hop: 'v20-21',
  title: "Relative router links with '../' that climb above the root (NG04005 in v21)",
  since: 21,
  removedIn: 21,
  fixRequires: 6,
  hint: "Up to v20 the router silently clamped a '../' above the root to '/'; v21 throws NG04005 \"Invalid number of '../'\" — and routerLink re-evaluates on every change detection, so the error floods the console. The auto-fix makes the blocker links absolute ('../settings/x' → '/settings/x'), which is what the old clamping produced. Warnings need the route depth checked by hand. Links bound from data ([routerLink]=\"menu.url\") cannot be checked here: check server-provided menu URLs for a leading '../'.",
  check({ project }) {
    const routes = routeIndex(project);
    const out: RawFinding[] = [];
    let dynamic = 0;
    for (const file of routerLinkFiles(project)) {
      const text = project.read(file);
      if (file.endsWith('.html') || /\btemplate\s*:/.test(text)) dynamic += (text.match(DYNAMIC_ROUTER_LINK) || []).length;
      const links = relativeRouterLinks(text);
      if (!links.length) continue;
      const reason = aboveRootReason(project, file, text, routes);
      for (const l of links) {
        const navigateFromRoot = (l.form === 'navigate' && !l.relativeTo);
        const blocker = !!reason || navigateFromRoot;
        const why = navigateFromRoot ? 'navigate() without relativeTo starts at the root' : reason;
        out.push(blocker
          ? { file, line: lineOf(text, l.offset), message: `${l.form} '${l.path}' climbs above the root (${why}) → '${clampRelativeLinks(l.path, [{ ...l, offset: 0 }])}' (auto-fixable)` }
          : { file, line: lineOf(text, l.offset), severity: 'warning', fixable: false, message: `${l.form} '${l.path}' — verify the route depth; Angular 21 throws NG04005 instead of clamping to the root` });
      }
    }
    if (dynamic) {
      out.push({ severity: 'info', fixable: false, message: `${dynamic} [routerLink] binding(s) take their path from data — check server-provided menu URLs for a leading '../'` });
    }
    return out;
  },
  fix({ project }) {
    const routes = routeIndex(project);
    transformFiles(project, routerLinkFiles(project), (text, file) => {
      const links = relativeRouterLinks(text);
      if (!links.length) return text;
      const reason = aboveRootReason(project, file, text, routes);
      return clampRelativeLinks(text, links.filter((l) => reason || (l.form === 'navigate' && !l.relativeTo)));
    });
  },
};

// ---------------------------------------------------------------------------
// v21 -> v22: TypeScript 6, removed Angular APIs, stricter templates
// ---------------------------------------------------------------------------

/** angularCompilerOptions of a tsconfig merged over the relative files it extends. */
function effectiveAngularOptions(project: Project, file: string, seen = new Set<string>()): Record<string, any> {
  if (seen.has(file) || !project.exists(file)) return {};
  seen.add(file);
  const json = project.readJson(file) || {};
  const ext = typeof json.extends === 'string' && json.extends.startsWith('.')
    ? effectiveAngularOptions(project, path.posix.normalize(path.posix.join(path.posix.dirname(file), json.extends)), seen)
    : {};
  return { ...ext, ...(json.angularCompilerOptions || {}) };
}

/** The tsconfigs a build or test run starts from. */
function entryTsconfigs(project: Project): string[] {
  const ws = project.readJson('angular.json');
  if (!ws) return tsconfigFiles(project).filter((f) => /(^|\/)tsconfig(\.app|\.spec)?\.json$/.test(f));
  // Every tsConfig an angular.json target uses (build, test, server, ...), plus the root one.
  const out = new Set<string>(project.exists('tsconfig.json') ? ['tsconfig.json'] : []);
  const visit = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'tsConfig' && typeof x === 'string' && project.exists(x.replace(/^\.\//, ''))) out.add(x.replace(/^\.\//, ''));
      else visit(x);
    }
  };
  visit(ws.projects);
  return [...out];
}

/** Entry tsconfigs and every relative file they extend: the configs a build or test run reads. */
function usedTsconfigs(project: Project): Set<string> {
  const used = new Set<string>();
  for (let file of entryTsconfigs(project)) {
    while (file && project.exists(file) && !used.has(file)) {
      used.add(file);
      const ext = (project.readJson(file) || {}).extends;
      file = typeof ext === 'string' && ext.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), ext)) : '';
    }
  }
  return used;
}

/** TS 6 deprecations are only warnings with "ignoreDeprecations": "6.0". */
function deprecationsIgnored(project: Project, file: string): boolean {
  return /^6\./.test(String(effectiveCompilerOptions(project, file).ignoreDeprecations || ''));
}

const tsStrictDefault: Rule = {
  id: 'ts/strict-default',
  hop: 'v21-22',
  title: 'TypeScript 6 turns "strict" on by default',
  since: 22,
  removedIn: 22,
  fixRequires: 6,
  hint: 'ng update to v22 installs TypeScript 6, where strict defaults to true: a project that never set it goes from 0 to thousands of errors (TS7053, TS7006, TS2564...). The auto-fix writes "strict": false into the root tsconfig.json to keep today\'s behaviour; turn strictness on later, flag by flag.',
  check({ project }) {
    if (!project.exists('tsconfig.json')) return [];
    const unset = entryTsconfigs(project).filter((f) => effectiveCompilerOptions(project, f).strict === undefined);
    return unset.length ? [{ file: 'tsconfig.json', message: `"strict" is not set in ${unset.join(', ')} (or what they extend) — TypeScript 6 would enable it → "strict": false (auto-fixable)` }] : [];
  },
  fix({ project }) {
    project.write('tsconfig.json', setJsonOption(project.read('tsconfig.json'), 'compilerOptions', 'strict', 'false'));
  },
};

const NAMESPACE_IMPORT = /import\s*\*\s*as\s+([\w$]+)\s+from\s*(['"])([^'".][^'"]*)\2\s*;?/g;

/** `import * as moment from 'moment'` whose binding is called (`moment()`): not callable under esModuleInterop. */
export function calledNamespaceImports(text: string): Array<{ name: string; from: string; offset: number; statement: string; constructed: boolean }> {
  const out: Array<{ name: string; from: string; offset: number; statement: string; constructed: boolean }> = [];
  const re = new RegExp(NAMESPACE_IMPORT.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rest = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    const name = m[1].replace(/\$/g, '\\$');
    const constructed = new RegExp(`\\bnew\\s+${name}\\s*\\(`).test(rest);
    if (constructed || new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(rest)) {
      out.push({ name: m[1], from: m[3], offset: m.index, statement: m[0], constructed });
    }
  }
  return out;
}

const tsCalledNamespaceImport: Rule = {
  id: 'ts/called-namespace-import',
  hop: 'v17+',
  title: 'Namespace imports that are called or constructed (TS2349 with TypeScript 6; runtime crash under esbuild)',
  since: 17,
  deprecatedIn: 17,
  removedIn: 22,
  fixRequires: 22,
  hint: "`import * as X from 'pkg'` is a namespace object: TypeScript 6 (esModuleInterop always on) rejects `X()` with TS2349, and with the esbuild application builder `new X()` builds with a warning (\"Constructing ... will crash at run-time because it's an import namespace object\") and then crashes in production. The auto-fix switches to a default import (import X from 'pkg'); before v22 it needs esModuleInterop/allowSyntheticDefaultImports.",
  check({ project }) {
    const esbuild = usesApplicationBuilder(project);
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      for (const c of calledNamespaceImports(text)) {
        const use = c.constructed ? `new ${c.name}()` : `${c.name}()`;
        out.push({
          file, line: lineOf(text, c.offset),
          // `new` on a namespace object is a production crash with esbuild, whatever the Angular version.
          ...(c.constructed && esbuild ? { severity: 'error' as const } : {}),
          message: `import * as ${c.name} from '${c.from}' is used as ${use}${c.constructed ? ' — crashes at run time under esbuild' : ''} → import ${c.name} from '${c.from}' (auto-fixable)`,
        });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) => {
      for (const c of calledNamespaceImports(text).reverse()) {
        text = text.slice(0, c.offset) + `import ${c.name} from '${c.from}';` + text.slice(c.offset + c.statement.length);
      }
      return text;
    });
  },
};

/** Narrow `paths` replacing `baseUrl`: one entry per top-level folder/file that bare imports reach through it. */
export function pathsReplacingBaseUrl(project: Project, file: string): Record<string, string[]> | undefined {
  const opts = (project.readJson(file) || {}).compilerOptions || {};
  if (typeof opts.baseUrl !== 'string') return undefined;
  const dir = path.posix.dirname(file);
  const base = path.posix.normalize(path.posix.join(dir, opts.baseUrl));
  const rel = (p: string): string => {
    const r = path.posix.relative(dir === '.' ? '' : dir, path.posix.normalize(path.posix.join(base, p)));
    return r.startsWith('.') ? r : `./${r}`;
  };
  const paths: Record<string, string[]> = {};
  // Existing paths are relative to baseUrl: rebase them on the tsconfig folder.
  for (const [key, values] of Object.entries<string[]>(opts.paths || {})) paths[key] = values.map(rel);
  const deps = project.declaredDeps;
  for (const ts of tsFiles(project)) {
    for (const { specifier } of importSpecifiers(project.read(ts))) {
      if (/^(\.|\/|[a-z]+:)/i.test(specifier) || specifier.startsWith('@')) continue;
      const seg = specifier.split('/')[0];
      if (deps[seg] || project.installedVersion(seg) !== undefined) continue;
      const target = path.posix.join(base, seg);
      if (!['', '.ts', '.d.ts'].some((ext) => project.exists(target + ext))) continue;
      // Never "*": the CLI's paths plugin would re-resolve every package and skip their "browser" fields.
      const key = specifier.includes('/') ? `${seg}/*` : seg;
      if (Object.keys(paths).some((k) => k === key || (k.endsWith('/*') && specifier.startsWith(k.slice(0, -1))))) continue;
      paths[key] = [rel(key)];
    }
  }
  return paths;
}

const ES2015_PLUS = /^es(6|20(1[5-9]|[2-9]\d)|next)$/i;

const tsDeprecatedOptions: Rule = {
  id: 'ts/deprecated-options',
  hop: 'v21-22',
  title: 'baseUrl and downlevelIteration are deprecated in TypeScript 6 (TS5101)',
  since: 22,
  removedIn: 22,
  fixRequires: 6,
  hint: 'TypeScript 6 reports TS5101 for these options. The auto-fix drops downlevelIteration when target is ES2015+, and replaces baseUrl with narrow "paths" entries for the folders bare imports actually reach through it (e.g. "app/*") — never "*": with the CLI\'s paths plugin that re-resolves every package and breaks "browser" field aliases (Can\'t resolve \'stream\'/\'crypto\'...). "ignoreDeprecations": "6.0" silences TS5101 for now.',
  check({ project }) {
    const out: RawFinding[] = [];
    const used = usedTsconfigs(project);
    for (const file of tsconfigFiles(project)) {
      const opts = (project.readJson(file) || {}).compilerOptions || {};
      const text = project.read(file);
      // A tsconfig no angular.json target uses (e.g. a leftover e2e/tsconfig.e2e.json) does not break the build.
      const sev = deprecationsIgnored(project, file) || !used.has(file) ? { severity: 'warning' as const } : {};
      if (opts.downlevelIteration !== undefined) {
        const target = String(effectiveCompilerOptions(project, file).target || '');
        const ok = ES2015_PLUS.test(target);
        out.push({ file, line: lineOf(text, text.indexOf('"downlevelIteration"')), fixable: ok, ...sev,
          message: ok ? `"downlevelIteration" is deprecated and a no-op for target ${target} → removed (auto-fixable)` : `"downlevelIteration" is deprecated; target ${target || '(default)'} still needs it — raise target to ES2015+ (manual)` });
      }
      if (typeof opts.baseUrl === 'string') {
        const paths = pathsReplacingBaseUrl(project, file)!;
        const keys = Object.keys(paths);
        out.push({ file, line: lineOf(text, text.indexOf('"baseUrl"')), ...sev,
          message: `"baseUrl" is deprecated → removed${keys.length ? `, with "paths" ${keys.map((k) => `"${k}"`).join(', ')}` : ''} (auto-fixable)` });
      }
    }
    return out;
  },
  fix({ project }) {
    for (const file of tsconfigFiles(project)) {
      const opts = (project.readJson(file) || {}).compilerOptions || {};
      let text = project.read(file);
      if (opts.downlevelIteration !== undefined && ES2015_PLUS.test(String(effectiveCompilerOptions(project, file).target || ''))) {
        text = removeJsonProp(text, 'downlevelIteration');
      }
      if (typeof opts.baseUrl === 'string') {
        const paths = pathsReplacingBaseUrl(project, file)!;
        text = removeJsonProp(removeJsonProp(text, 'baseUrl'), 'paths', JSON_OBJECT);
        if (Object.keys(paths).length) text = setJsonOption(text, 'compilerOptions', 'paths', JSON.stringify(paths));
      }
      project.write(file, text);
    }
  },
};

/** Exports a target Angular major removed, for checking library bundles before the update. */
const REMOVED_ANGULAR_EXPORTS: Record<number, Record<string, string[]>> = {
  22: { '@angular/core': ['ComponentFactoryResolver'], '@angular/platform-browser': ['HammerLoader', 'HAMMER_LOADER'] },
};

/** `{ '@angular/core': Set(['NgClass', ...]) }` — Angular symbols a bundle imports (named or via `i0.X`). */
export function angularImportsOf(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (pkg: string, name: string): void => {
    if (!out.has(pkg)) out.set(pkg, new Set());
    out.get(pkg)!.add(name);
  };
  let m: RegExpExecArray | null;
  const named = /import\s*\{([^}]*)\}\s*from\s*['"](@angular\/[\w-]+)(?:\/[\w-]+)?['"]/g;
  while ((m = named.exec(text))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) add(m[2], name);
    }
  }
  const ns = /import\s*\*\s*as\s+([\w$]+)\s+from\s*['"](@angular\/[\w-]+)['"]/g;
  while ((m = ns.exec(text))) {
    const use = new RegExp(`(?<![\\w$.])${m[1].replace(/\$/g, '\\$')}\\.([\\w$ɵ]+)`, 'g');
    let u: RegExpExecArray | null;
    while ((u = use.exec(text))) add(m[2], u[1]);
  }
  return out;
}

/** Whether the installed @angular/<pkg> still declares `name` anywhere in its .d.ts files (undefined: not installed). */
function installedAngularDeclares(project: Project, pkg: string, cache: Map<string, string | null>): ((name: string) => boolean) | undefined {
  if (!cache.has(pkg)) {
    const dir = path.join(project.root, 'node_modules', pkg);
    const files = fs.existsSync(dir) ? typingFiles(dir) : [];
    cache.set(pkg, files.length ? files.map((f) => fs.readFileSync(f, 'utf8')).join('\n') : null);
  }
  const text = cache.get(pkg);
  // Not \b: names like ɵɵngDeclareFactory start with a non-word character.
  return text ? (name) => new RegExp(`(?<![\\w$ɵ])${name.replace(/\$/g, '\\$')}(?![\\w$ɵ])`).test(text) : undefined;
}

/**
 * The package's own typings: every .d.ts next to the files its package.json "types"/"typings"/exports
 * point at (Angular splits them into chunk files). Falls back to a bounded walk.
 */
function typingFiles(dir: string): string[] {
  let pkg: any = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    // no package.json
  }
  const entries = new Set<string>();
  const visit = (v: any, key?: string): void => {
    if (typeof v === 'string') {
      if (key === 'types' || key === 'typings' || v.endsWith('.d.ts')) entries.add(v);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(pkg.types, 'types');
  visit(pkg.typings, 'typings');
  visit(pkg.exports);
  const dirs = new Set([...entries].map((e) => path.dirname(path.join(dir, e))));
  const out: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) if (f.endsWith('.d.ts')) out.push(path.join(d, f));
    } catch {
      // missing folder
    }
  }
  return out.length ? out : collectDts(dir);
}

function collectDts(dir: string, limit = 400): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const removedAngularApis: Rule = {
  id: 'deps/removed-angular-apis',
  hop: 'v21-22',
  title: 'Libraries importing Angular APIs the target version removed (runtime/build failure)',
  since: 22,
  removedIn: 22,
  hint: 'A library bundle that imports a removed export (ComponentFactoryResolver, HammerLoader, ...) compiles against old typings but fails when the app loads it. Upgrade or replace the library — `ngx-upgrade-doctor deps --target <N> --online`. Before the update this uses a built-in list; once the new @angular/* is installed it checks against its real typings.',
  check({ project, version }) {
    const removedByTable = REMOVED_ANGULAR_EXPORTS[version] || {};
    const angularMajor = project.angularMajor || 0;
    const cache = new Map<string, string | null>();
    const out: RawFinding[] = [];
    for (const name of Object.keys(project.declaredDeps)) {
      if (name.startsWith('@angular/')) continue;
      const dir = path.join(project.root, 'node_modules', name);
      if (!fs.existsSync(dir)) continue;
      const hits = new Set<string>();
      for (const file of libraryFiles(dir)) {
        let text: string;
        try {
          if (fs.statSync(file).size > 3_000_000) continue;
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (!text.includes('@angular/')) continue;
        for (const [pkg, names] of angularImportsOf(text)) {
          const declares = angularMajor >= version ? installedAngularDeclares(project, pkg, cache) : undefined;
          for (const n of names) {
            if ((removedByTable[pkg] || []).includes(n) || (declares && !declares(n))) hits.add(`${pkg}: ${n}`);
          }
        }
      }
      if (!hits.size) continue;
      const current = project.installedVersion(name) || project.declaredDeps[name];
      const known = knownBreaker(name, current, version);
      const removal = REMOVALS.find((r) => r.name.test(name) && version >= r.at);
      const fixHint = known ? ` → ${known.action} ${known.suggested}` : removal && removal.suggested ? ` → replace with ${removal.suggested.replace('<N>', String(version))}` : ' → upgrade or replace it';
      out.push({ file: 'package.json', message: `${name}@${current} imports removed ${[...hits].join(', ')}${fixHint}` });
    }
    return out;
  },
};

/** ngx-image-cropper 9 ships a standalone component instead of ImageCropperModule. */
export function migrateImageCropperImports(text: string): string {
  if (!/from\s*['"]ngx-image-cropper['"]/.test(text) || !/\bImageCropperModule\b/.test(text)) return text;
  let out = text.replace(/\bImageCropperModule\b/g, 'ImageCropperComponent');
  out = out.replace(/import\s*\{([^}]*)\}\s*from\s*(['"])ngx-image-cropper\2/, (whole, names: string, q: string) => {
    const unique = [...new Set(names.split(',').map((s) => s.trim()).filter(Boolean))];
    return `import { ${unique.join(', ')} } from ${q}ngx-image-cropper${q}`;
  });
  return out;
}

/** ngx-material-timepicker → its maintained successor ngx-mat-timepicker (TS imports and templates). */
export function migrateTimepicker(text: string): string {
  return text
    .replace(/(['"])ngx-material-timepicker\1/g, '$1ngx-mat-timepicker$1')
    .replace(/\bNgxMaterialTimepicker(\w*)/g, 'NgxMatTimepicker$1')
    .replace(/<(\/?)ngx-material-timepicker\b/g, '<$1ngx-mat-timepicker')
    .replace(/\[ngxTimepicker\]/g, '[ngxMatTimepicker]');
}

const libraryApiRenames: Rule = {
  id: 'deps/library-api-renames',
  hop: 'v21-22',
  title: 'Library swaps for Angular 22 (ngx-material-timepicker, ngx-image-cropper 9)',
  since: 22,
  removedIn: 22,
  fixRequires: 6,
  hint: 'ngx-material-timepicker is abandoned and uses removed Angular APIs: the auto-fix swaps it for ngx-mat-timepicker@^<N> (NgxMaterialTimepickerModule → NgxMatTimepickerModule, <ngx-material-timepicker> → <ngx-mat-timepicker>, [ngxTimepicker] → [ngxMatTimepicker]) and drops luxon when nothing else imports it. ngx-image-cropper 9 replaces ImageCropperModule with the standalone ImageCropperComponent — renamed once package.json asks for ^9.',
  check({ project, version }) {
    const out: RawFinding[] = [];
    const cropperMin = project.declaredDeps['ngx-image-cropper'] && semver.minVersion(project.declaredDeps['ngx-image-cropper'].replace(/^npm:.*@/, ''));
    const cropperReady = !!cropperMin && semver.major(cropperMin) >= 9;
    for (const file of [...tsFiles(project), ...project.files(...TEMPLATES)]) {
      const text = project.read(file);
      if (migrateTimepicker(text) !== text) {
        out.push({ file, line: lineOf(text, text.search(/ngx-material-timepicker|NgxMaterialTimepicker|\[ngxTimepicker\]/)), message: `ngx-material-timepicker → ngx-mat-timepicker@^${version}.0.0 (auto-fixable)` });
      }
      if (file.endsWith('.ts') && migrateImageCropperImports(text) !== text) {
        out.push({
          file, line: lineOf(text, text.search(/\bImageCropperModule\b/)), fixable: cropperReady,
          message: cropperReady ? 'ImageCropperModule → ImageCropperComponent (ngx-image-cropper 9, auto-fixable)' : 'ImageCropperModule → ImageCropperComponent once ngx-image-cropper is ^9 — run deps first (manual)',
        });
      }
    }
    return out;
  },
  fix({ project, version }) {
    if (project.declaredDeps['ngx-material-timepicker']) {
      swapDep(project, 'ngx-material-timepicker', 'ngx-mat-timepicker', `^${version}.0.0`);
    }
    const cropperMin = project.declaredDeps['ngx-image-cropper'] && semver.minVersion(project.declaredDeps['ngx-image-cropper'].replace(/^npm:.*@/, ''));
    const files = [...tsFiles(project), ...project.files(...TEMPLATES)];
    transformFiles(project, files, (text, file) => {
      let next = migrateTimepicker(text);
      if (file.endsWith('.ts') && cropperMin && semver.major(cropperMin) >= 9) next = migrateImageCropperImports(next);
      return next;
    });
    // luxon was only a peer of ngx-material-timepicker.
    if (!project.declaredDeps['ngx-material-timepicker'] && !tsFiles(project).some((f) => /['"]luxon['"]/.test(project.read(f)))) {
      removeDeps(project, ['luxon', '@types/luxon']);
    }
  },
};

/** Expression text of a template: interpolations, bound attribute values and block headers. */
function templateExpressions(text: string): string {
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  const interp = /\{\{([\s\S]*?)\}\}/g;
  while ((m = interp.exec(text))) parts.push(m[1]);
  const bound = /[\s<](?:\[[^\]]+\]|\([^)]+\)|\*[\w.]+|bind-[\w-]+|on-[\w-]+)\s*=\s*(["'])([\s\S]*?)\1/g;
  while ((m = bound.exec(text))) parts.push(m[2]);
  const blocks = /@(?:if|else if|for|switch|case|let|defer)\b\s*\(([^)]*)\)/g;
  while ((m = blocks.exec(text))) parts.push(m[1]);
  return parts.join('\n');
}

const NGFOR_IN = /(\*ngFor\s*=\s*["']\s*let\s+)in(\s+of\b)/g;
/** `@for (in of ...) {` — the whole header up to the block, since it can contain calls like counter(3). */
const FOR_BLOCK_IN = /(@for\s*\(\s*)in(\s+of\b[^{]*)\{/g;

/** Renames a loop variable called `in` (rejected by the v22 template parser) and tracks @for loops by $index. */
export function renameInLoopVariable(text: string): { text: string; loops: number; blocked: boolean } {
  const loops = (text.match(new RegExp(NGFOR_IN.source, 'g')) || []).length + (text.match(new RegExp(FOR_BLOCK_IN.source, 'g')) || []).length;
  if (!loops) return { text, loops, blocked: false };
  const stripped = text.replace(new RegExp(NGFOR_IN.source, 'g'), '').replace(new RegExp(FOR_BLOCK_IN.source, 'g'), '');
  // `in` used inside the loop body means a real rename of every use — leave that to a human.
  if (/(?<![\w$.])in(?![\w$])/.test(templateExpressions(stripped).replace(/(['"`])(?:(?!\1).)*\1/g, ''))) return { text, loops, blocked: true };
  const name = /\bitem\b/.test(text) ? 'loopItem' : 'item';
  const out = text
    .replace(new RegExp(NGFOR_IN.source, 'g'), `$1${name}$2`)
    .replace(new RegExp(FOR_BLOCK_IN.source, 'g'), (_m, head: string, rest: string) =>
      `${head}${name}${rest.replace(/\btrack\s+in\b/, 'track $index')}{`);
  return { text: out, loops, blocked: false };
}

const loopVariableIn: Rule = {
  id: 'template/loop-variable-named-in',
  hop: 'v21-22',
  title: 'Loop variable named "in" (template parse error in v22)',
  since: 17,
  deprecatedIn: 17,
  removedIn: 22,
  hint: 'The v21 control-flow migration turns *ngFor="let in of counter(12)" into @for (in of ...; track in), which Angular 22 rejects ("Unexpected token in", "@for loop must have a track expression"). The auto-fix renames the variable when the template does not use it and tracks by $index (counter()-style arrays hold empty slots, so tracking by item would duplicate keys).',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of templateSources(project)) {
      const text = project.read(file);
      const r = renameInLoopVariable(text);
      if (!r.loops) continue;
      const at = text.search(/\*ngFor\s*=\s*["']\s*let\s+in\s+of\b|@for\s*\(\s*in\s+of\b/);
      // *ngFor microsyntax still accepts `in`; only the migrated @for block fails to parse.
      const migrated = new RegExp(FOR_BLOCK_IN.source).test(text);
      out.push({
        file, line: lineOf(text, at), fixable: !r.blocked, ...(migrated ? {} : { severity: 'warning' as const }),
        message: r.blocked ? `${r.loops} loop(s) use a variable named "in" that the template also reads — rename it by hand (manual)` : `${r.loops} loop(s) with a variable named "in" → renamed, track $index (auto-fixable)`,
      });
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, templateSources(project), (text) => renameInLoopVariable(text).text);
  },
};

const GENERIC_BUTTON = /(\s)(mat-(?:raised-|flat-|stroked-)?button)(\s*=\s*(?:"[^"]*"|'[^']*'))?(?=[\s/>])/;
const FAB_BUTTON = /\s(mat-mini-fab|mat-fab|mat-icon-button)(?=[\s=/>])/;

/** <button>/<a> tags carrying a generic MatButton variant and a fab/icon variant (NG8023 in v22). */
export function conflictingButtonVariants(text: string): Array<{ offset: number; generic: string; fab: string; remove: [number, number] }> {
  // Blank out comments and attribute values (same length) so offsets stay valid.
  const masked = text
    .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(=\s*)("[^"]*"|'[^']*')/g, (_m, eq: string, v: string) => eq + v[0] + v.slice(1, -1).replace(/[^\n]/g, ' ') + v[0]);
  const out: Array<{ offset: number; generic: string; fab: string; remove: [number, number] }> = [];
  const tag = /<(button|a)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(masked))) {
    const attrs = m[2];
    const g = GENERIC_BUTTON.exec(attrs);
    const f = FAB_BUTTON.exec(attrs);
    if (!g || !f) continue;
    const start = m.index + 1 + m[1].length + g.index;
    out.push({ offset: m.index, generic: g[2], fab: f[1], remove: [start, start + g[0].length] });
  }
  return out;
}

const conflictingButtons: Rule = {
  id: 'material/conflicting-button-variants',
  hop: 'v21-22',
  title: 'Buttons with two Material button variants (NG8023 in v22)',
  since: 22,
  removedIn: 22,
  fixRequires: 15,
  hint: 'A <button>/<a> with both mat-raised-button/mat-button/mat-flat-button/mat-stroked-button and mat-mini-fab/mat-fab/mat-icon-button matches two components ("Multiple components match node with tagname button"). The auto-fix drops the generic variant and keeps the fab/icon one, which is the shape users see. Templates not compiled yet are covered too.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files(...TEMPLATES)) {
      const text = project.read(file);
      if (!/mat-(mini-fab|fab|icon-button)/.test(text)) continue;
      for (const c of conflictingButtonVariants(text)) {
        out.push({ file, line: lineOf(text, c.offset), message: `${c.generic} together with ${c.fab} → keep ${c.fab} (auto-fixable)` });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, project.files(...TEMPLATES), (text) => {
      for (const c of conflictingButtonVariants(text).reverse()) text = text.slice(0, c.remove[0]) + text.slice(c.remove[1]);
      return text;
    });
  },
};

const extendedDiagnosticsWithoutStrictTemplates: Rule = {
  id: 'build/extended-diagnostics-without-strict-templates',
  hop: 'v21-22',
  title: 'extendedDiagnostics configured while strictTemplates is false (NG4003)',
  since: 22,
  removedIn: 22,
  fixRequires: 6,
  hint: 'Angular 22 migrations can add both extendedDiagnostics.checks suppressions and "strictTemplates": false; the compiler then stops with NG4003. Extended diagnostics only run under strictTemplates, so the auto-fix removes the extendedDiagnostics block.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of tsconfigFiles(project)) {
      const own = (project.readJson(file) || {}).angularCompilerOptions || {};
      if (own.extendedDiagnostics === undefined || effectiveAngularOptions(project, file).strictTemplates !== false) continue;
      const text = project.read(file);
      out.push({ file, line: lineOf(text, text.indexOf('"extendedDiagnostics"')), message: 'extendedDiagnostics with strictTemplates: false → removed (auto-fixable)' });
    }
    return out;
  },
  fix({ project }) {
    for (const file of tsconfigFiles(project)) {
      const own = (project.readJson(file) || {}).angularCompilerOptions || {};
      if (own.extendedDiagnostics === undefined || effectiveAngularOptions(project, file).strictTemplates !== false) continue;
      project.write(file, removeJsonProp(project.read(file), 'extendedDiagnostics', JSON_OBJECT));
    }
  },
};

// ---------------------------------------------------------------------------
// esbuild application builder, package.json scripts, workspace hygiene
// ---------------------------------------------------------------------------

/** Packages whose Node-only branches `require('jsdom')` and drag Node built-ins into an esbuild browser bundle. */
function jsdomPullers(project: Project): string[] {
  const out: string[] = [];
  const fabric = project.installedVersion('fabric');
  if (fabric && semver.valid(fabric) && semver.lt(fabric, '6.0.0')) out.push(`fabric@${fabric}`);
  const canvg = project.installedVersion('canvg');
  if (canvg && semver.valid(canvg) && semver.lt(canvg, '2.0.0')) out.push(`canvg@${canvg}`);
  const jsdom = project.installedVersion('jsdom');
  if (jsdom) out.push(`jsdom@${jsdom}`);
  return out;
}

function wantedExternals(project: Project): string[] {
  return ['jsdom', ...(project.installedVersion('canvas') ? ['canvas'] : [])];
}

const esbuildExternalDependencies: Rule = {
  id: 'build/esbuild-external-dependencies',
  hop: 'v17+',
  title: 'jsdom bundled into the browser build by the esbuild application builder',
  since: 17,
  removedIn: 17,
  fixRequires: 6,
  hint: 'fabric < 6 and canvg < 2 (also via jspdf 1 / html2pdf.js) require(\'jsdom\') in Node-only branches. Webpack honoured their package.json "browser" maps; esbuild bundles jsdom and fails with ~100 "Could not resolve \\"util\\"/\\"crypto\\"/\\"fs\\"" errors. The auto-fix adds "externalDependencies": ["jsdom"] (and "canvas" when installed) to the build options — and excludes those libraries from the dev server\'s pre-bundling, which would otherwise turn the external require into a top-level `import "jsdom"` ("Failed to resolve module specifier \\"jsdom\\"" on `ng serve`).',
  check({ project }) {
    if (!usesApplicationBuilder(project)) return [];
    const pullers = jsdomPullers(project);
    if (!pullers.length) return [];
    const want = wantedExternals(project);
    const out: RawFinding[] = [];
    for (const t of buildTargets(project).filter((x) => /:application$/.test(x.builder))) {
      const have: string[] = t.options.externalDependencies || [];
      // jsdom is what breaks the bundle; canvas only rides along when the fix adds jsdom anyway.
      if (have.includes('jsdom')) continue;
      const missing = want.filter((w) => !have.includes(w));
      if (missing.length) out.push({ file: 'angular.json', message: `${t.name}: ${pullers.join(', ')} installed — add "externalDependencies": [${missing.map((m) => `"${m}"`).join(', ')}] (auto-fixable)` });
    }
    for (const s of devServerTargets(project)) {
      const exclude = prebundleExcludesNeeded(project, s.options);
      if (exclude.length) {
        out.push({ file: 'angular.json', message: `${s.name}: ng serve pre-bundles ${exclude.join(', ')} with jsdom external → "Failed to resolve module specifier \\"jsdom\\"" in the browser — add "prebundle": { "exclude": [${exclude.map((e) => `"${e}"`).join(', ')}] } (auto-fixable)` });
      }
    }
    return out;
  },
  fix({ project }) {
    const ws = project.readJson('angular.json');
    if (!ws) return;
    const want = wantedExternals(project);
    for (const p of Object.values<any>(ws.projects || {})) {
      const targets = (p && (p.architect || p.targets)) || {};
      const build = targets.build;
      if (!build || !/:application$/.test(String(build.builder || ''))) continue;
      build.options = build.options || {};
      build.options.externalDependencies = [...new Set([...(build.options.externalDependencies || []), ...want])];
      const serve = targets.serve;
      if (serve && /:dev-server$/.test(String(serve.builder || ''))) {
        serve.options = serve.options || {};
        const exclude = prebundleExcludesNeeded(project, serve.options);
        if (exclude.length) {
          const pre = typeof serve.options.prebundle === 'object' && serve.options.prebundle ? serve.options.prebundle : {};
          serve.options.prebundle = { ...pre, exclude: [...new Set([...(pre.exclude || []), ...exclude])] };
        }
      }
    }
    project.writeJson('angular.json', ws);
  },
};

/** `serve` targets using the Vite-based dev server. */
function devServerTargets(project: Project): Array<{ name: string; options: Record<string, any> }> {
  const ws = project.readJson('angular.json') || {};
  return Object.entries<any>(ws.projects || {})
    .map(([name, p]) => ({ name, serve: p && (p.architect || p.targets || {}).serve }))
    .filter((x) => x.serve && /:dev-server$/.test(String(x.serve.builder || '')))
    .map((x) => ({ name: x.name, options: x.serve.options || {} }));
}

/** Packages that require('jsdom') and that the dev server would still pre-bundle. */
function prebundleExcludesNeeded(project: Project, serveOptions: Record<string, any>): string[] {
  if (serveOptions.prebundle === false) return [];
  const excluded: string[] = (serveOptions.prebundle && serveOptions.prebundle.exclude) || [];
  // Only packages the app imports itself: a nested canvg resolves to its browser build, which has no jsdom.
  const imported = new Set<string>();
  for (const file of tsFiles(project)) {
    for (const { specifier } of importSpecifiers(project.read(file))) {
      const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      imported.add(pkg);
    }
  }
  return jsdomPullers(project).map((p) => p.replace(/@[^@]*$/, '')).filter((n) => n !== 'jsdom' && imported.has(n) && !excluded.includes(n));
}

/** jspdf 1.x APIs that jspdf 2 removed or changed. */
const JSPDF1_APIS: Array<{ name: string; re: RegExp }> = [
  { name: 'setFontStyle()', re: /\.setFontStyle\(/g },
  { name: 'setFontType()', re: /\.setFontType\(/g },
  { name: 'fromHTML()', re: /\.fromHTML\(/g },
  { name: "text(..., 'center') flag", re: /\.text\([^;]*?,\s*['"]center['"]\s*\)/g },
  { name: 'addHTML()', re: /\.addHTML\(/g },
];

const jspdfBreakingApi: Rule = {
  id: 'deps/jspdf-2-breaking-api',
  hop: 'every hop',
  title: 'jspdf 1 → 2 is a breaking upgrade (removed APIs in use)',
  since: 6,
  level: 'warning',
  hint: 'Peers such as jspdf-autotable ask for jspdf ^2, but jspdf 2 removed setFontStyle/setFontType (→ setFont(name, style)), fromHTML/addHTML (→ html()), and the old text(..., \'center\') flags (→ { align: \'center\' }). Upgrade deliberately, not as a peer fix — expect hundreds of TS errors otherwise.',
  check({ project }) {
    const current = project.installedVersion('jspdf') || project.declaredDeps.jspdf;
    const min = current && (semver.valid(current) || (semver.minVersion(current) || { version: '' }).version);
    if (!min || semver.major(min) >= 2) return [];
    const counts = new Map<string, number>();
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      if (!/jspdf|jsPDF/i.test(text)) continue;
      for (const api of JSPDF1_APIS) counts.set(api.name, (counts.get(api.name) || 0) + (text.match(new RegExp(api.re.source, 'g')) || []).length);
    }
    const used = [...counts].filter(([, n]) => n).map(([name, n]) => `${name} ×${n}`);
    return depFinding(project, 'jspdf', `check before upgrading to 2.x: breaking API changes${used.length ? ` — in use: ${used.join(', ')}` : ''}`);
  },
};

/** Actual on-disk spelling of workspace files, keyed by lower-cased path. */
function caseIndex(project: Project): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of project.files('')) map.set(f.toLowerCase(), f);
  return map;
}

export interface CaseMismatch {
  offset: number;
  /** The reference as written. */
  written: string;
  /** The same reference with the on-disk casing. */
  fixed: string;
}

/** References (templateUrl, styleUrl(s), relative imports, url()) whose casing differs from the file on disk. */
export function caseMismatches(file: string, text: string, index: Map<string, string>): CaseMismatch[] {
  const out: CaseMismatch[] = [];
  const dir = path.posix.dirname(file);
  const check = (written: string, offset: number, exts: string[]): void => {
    if (/^([a-z][a-z\d+.-]*:|\/|~|\^|#|data:)/i.test(written) || /[{}$]/.test(written)) return;
    const clean = written.replace(/[?#].*$/, '');
    const base = path.posix.normalize(path.posix.join(dir, clean));
    for (const ext of exts) {
      const candidate = base + ext;
      const real = index.get(candidate.toLowerCase());
      if (!real) continue;
      if (real === candidate) return;
      // Rebuild the reference segment by segment with the real casing.
      const realNoExt = ext ? real.slice(0, -ext.length) : real;
      let rel = path.posix.relative(dir, realNoExt);
      if (clean.startsWith('./') && !rel.startsWith('.')) rel = `./${rel}`;
      out.push({ offset, written: clean, fixed: rel });
      return;
    }
  };
  let m: RegExpExecArray | null;
  if (file.endsWith('.ts')) {
    const urls = /\b(templateUrl|styleUrl)\s*:\s*(['"`])([^'"`]+)\2|\bstyleUrls\s*:\s*\[([^\]]*)\]/g;
    while ((m = urls.exec(text))) {
      if (m[3]) check(m[3], m.index + m[0].indexOf(m[3]), ['']);
      else {
        const list = /(['"`])([^'"`]+)\1/g;
        let s: RegExpExecArray | null;
        while ((s = list.exec(m[4]))) check(s[2], m.index + m[0].indexOf(m[4]) + s.index + 1, ['']);
      }
    }
    for (const { specifier, offset } of importSpecifiers(text)) {
      if (specifier.startsWith('.')) check(specifier, offset + 1, ['', '.ts', '/index.ts']);
    }
  }
  const css = /\burl\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
  while ((m = css.exec(text))) check(m[2], m.index + m[0].indexOf(m[2], 4), ['']);
  return out;
}

const fileNameCase: Rule = {
  id: 'build/file-name-case',
  hop: 'every hop',
  title: 'File references whose letter case differs from the file on disk',
  since: 6,
  level: 'warning',
  fixRequires: 6,
  hint: 'Windows and macOS forgive url("logo.jpg") for Logo.jpg or templateUrl: \'./occupationpopup.html\' for occupationPopup.html; Linux CI does not, and esbuild warns [different-path-case]. The auto-fix rewrites each reference with the real casing.',
  check({ project }) {
    const index = caseIndex(project);
    const out: RawFinding[] = [];
    for (const file of [...tsFiles(project), ...project.files(...TEMPLATES), ...project.files(...STYLES)]) {
      const text = project.read(file);
      for (const c of caseMismatches(file, text, index)) {
        out.push({ file, line: lineOf(text, c.offset), message: `'${c.written}' → '${c.fixed}' (case differs from the file on disk, auto-fixable)` });
      }
    }
    return out;
  },
  fix({ project }) {
    const index = caseIndex(project);
    transformFiles(project, [...tsFiles(project), ...project.files(...TEMPLATES), ...project.files(...STYLES)], (text, file) => {
      for (const c of caseMismatches(file, text, index).reverse()) text = text.slice(0, c.offset) + c.fixed + text.slice(c.offset + c.written.length);
      return text;
    });
  },
};

/** ng build/serve flags the application builder rejects. */
const WEBPACK_ONLY_FLAGS = /\s--(build-optimizer|vendor-chunk|common-chunk|deploy-url)(?:(?:=|\s+)(?!-)[^\s&|;]+)?(?=\s|$|[&|;])/g;
const NPM_RUN_SWALLOW = /(\bnpm\s+run(?:-script)?\s+[\w:.-]+)((?:\s+(?!--(?:\s|$))[^\s&|;]+)*?\s+--[\w-])/;

export interface ScriptProblem {
  kind: 'webpack-flag' | 'duplicate-configuration' | 'npm-run-without-dashes' | 'old-space';
  message: string;
  fixable: boolean;
}

/** Problems in one package.json script. `ramMb` caps the sensible --max_old_space_size. */
export function scriptProblems(script: string, applicationBuilder: boolean, ramMb: number): ScriptProblem[] {
  const out: ScriptProblem[] = [];
  const ngCommands = script.split(/&&|\|\||;/).filter((c) => /\bng\s+(build|serve|b|s)\b/.test(c));
  if (applicationBuilder) {
    for (const c of ngCommands) {
      for (const m of c.match(new RegExp(WEBPACK_ONLY_FLAGS.source, 'g')) || []) {
        out.push({ kind: 'webpack-flag', fixable: true, message: `${m.trim()} is not accepted by the application builder → removed (auto-fixable)` });
      }
    }
  }
  for (const c of ngCommands) {
    const configs = c.match(/(?:--configuration|(?<=\s)-c)(?:=|\s+)[^\s&|;]+/g) || [];
    if (configs.length > 1) out.push({ kind: 'duplicate-configuration', fixable: false, message: `${configs.join(' ')} — only the last one applies; use one --configuration=a,b` });
  }
  if (NPM_RUN_SWALLOW.test(script)) {
    out.push({ kind: 'npm-run-without-dashes', fixable: true, message: 'npm run <script> --flag without "--": npm keeps the flags for itself → insert "--" (auto-fixable)' });
  }
  const space = /--max[_-]old[_-]space[_-]size=(\d+)/.exec(script);
  if (space && Number(space[1]) > Math.min(ramMb, 16384)) {
    out.push({ kind: 'old-space', fixable: false, message: `--max_old_space_size=${space[1]} MB is more than ${Math.min(ramMb, 16384)} MB — Node then rarely collects garbage and ng serve keeps growing; use 8192` });
  }
  return out;
}

export function fixScript(script: string, applicationBuilder: boolean): string {
  let out = applicationBuilder
    ? script.split(/(&&|\|\||;)/).map((c) => (/\bng\s+(build|serve|b|s)\b/.test(c) ? c.replace(new RegExp(WEBPACK_ONLY_FLAGS.source, 'g'), '') : c)).join('')
    : script;
  out = out.replace(new RegExp(NPM_RUN_SWALLOW.source, 'g'), (whole: string, head: string) => `${head} --${whole.slice(head.length)}`);
  return out;
}

const packageScripts: Rule = {
  id: 'build/package-scripts',
  hop: 'every hop',
  title: 'package.json scripts with flags that are rejected, ignored or harmful',
  since: 6,
  level: 'warning',
  fixRequires: 6,
  hint: 'The application builder rejects --build-optimizer, --vendor-chunk, --common-chunk and --deploy-url (auto-fix removes them; use "deployUrl"-free relative assets). A repeated --configuration keeps only the last. `npm run x --flag` without `--` hands the flag to npm, not to ng (auto-fix inserts --). A huge --max_old_space_size makes Node postpone garbage collection — 8192 is plenty for big apps.',
  check({ project }) {
    const esbuild = usesApplicationBuilder(project);
    const ram = Math.floor(os.totalmem() / 1024 / 1024);
    const text = project.read('package.json');
    const out: RawFinding[] = [];
    for (const [name, script] of Object.entries(project.pkg.scripts || {})) {
      const line = lineOf(text, text.indexOf(`"${name}"`));
      for (const p of scriptProblems(String(script), esbuild, ram)) {
        out.push({ file: 'package.json', line, fixable: p.fixable, message: `scripts.${name}: ${p.message}` });
      }
    }
    return out;
  },
  fix({ project }) {
    const esbuild = usesApplicationBuilder(project);
    const pkg = project.pkg;
    let changed = false;
    for (const [name, script] of Object.entries(pkg.scripts || {})) {
      const next = fixScript(String(script), esbuild);
      if (next !== script) {
        pkg.scripts![name] = next;
        changed = true;
      }
    }
    if (changed) project.writeJson('package.json', pkg);
  },
};

/** Deploy/CI files that may copy the build output. */
function deployFiles(project: Project): string[] {
  return project.files('').filter((f) => /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|azure-pipelines[^/]*\.ya?ml|bitbucket-pipelines\.yml|Jenkinsfile|Dockerfile[^/]*|[^/]+\.(sh|ps1|bat|cmd))$/.test(f));
}

const applicationBuilderOutput: Rule = {
  id: 'build/application-builder-output',
  hop: 'v17+',
  title: 'Deploy scripts copying dist/<app> — the application builder writes to dist/<app>/browser',
  since: 17,
  level: 'warning',
  hint: 'After use-application-builder the browser bundle lands in dist/<app>/browser (server files in dist/<app>/server). Point deploy scripts, Dockerfiles and CI artifact paths at the browser folder, or set "outputPath": { "base": "dist/<app>", "browser": "" } to keep the old layout.',
  check({ project }) {
    if (!usesApplicationBuilder(project)) return [];
    const bases = buildTargets(project).filter((t) => /:application$/.test(t.builder)).map((t) => {
      const o = t.options.outputPath;
      if (o && typeof o === 'object') return o.browser === '' ? undefined : String(o.base || `dist/${t.name}`);
      return typeof o === 'string' ? o : `dist/${t.name}`;
    }).filter((b): b is string => !!b).map((b) => b.replace(/^\.\//, '').replace(/\/+$/, ''));
    const out: RawFinding[] = [];
    for (const base of [...new Set(bases)]) {
      const re = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]*browser)(?=[/\\s'"*]|$)`, 'm');
      for (const file of [...deployFiles(project), 'package.json']) {
        const text = project.read(file);
        const m = re.exec(text);
        if (m && (file !== 'package.json' || /\b(cp|copy|xcopy|robocopy|rsync|scp|deploy|publish|aws|az|gsutil|firebase)\b/.test(text.slice(text.lastIndexOf('\n', m.index), text.indexOf('\n', m.index))))) {
          out.push({ file, line: lineOf(text, m.index), message: `uses ${base} — the application builder output is ${base}/browser` });
        }
      }
    }
    return out;
  },
};

/** <mat-icon> placed after the label inside an MDC button, without iconPositionEnd (MDC moves it before the label). */
export function trailingButtonIcons(text: string): Array<{ offset: number; insertAt: number }> {
  const out: Array<{ offset: number; insertAt: number }> = [];
  const re = /<(button|a)\b([^>]*\bmat-(?:raised-|flat-|stroked-)?button\b[^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const content = m[3];
    const iconAt = content.lastIndexOf('<mat-icon');
    if (iconAt < 0) continue;
    const iconTag = /^<mat-icon\b[^>]*>/.exec(content.slice(iconAt));
    if (!iconTag || /\biconPosition(End)?\b/.test(iconTag[0])) continue;
    const after = content.slice(iconAt).replace(/^<mat-icon\b[^>]*>[\s\S]*?<\/mat-icon\s*>/, '');
    const before = content.slice(0, iconAt).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
    if (after.trim() || !before.trim()) continue;
    const contentStart = m.index + m[0].indexOf('>') + 1;
    out.push({ offset: contentStart + iconAt, insertAt: contentStart + iconAt + '<mat-icon'.length });
  }
  return out;
}

const buttonTrailingIcon: Rule = {
  id: 'material/button-trailing-icon',
  hop: 'v15+',
  title: 'Trailing <mat-icon> in MDC buttons jumps before the label',
  since: 15,
  level: 'warning',
  fixRequires: 15,
  hint: 'MDC buttons project <mat-icon> in front of the label, so a trailing icon (dropdown arrow, chevron) moves to the left. Mark it with iconPositionEnd — the auto-fix adds it.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files(...TEMPLATES)) {
      const text = project.read(file);
      if (!text.includes('<mat-icon')) continue;
      for (const t of trailingButtonIcons(text)) out.push({ file, line: lineOf(text, t.offset), message: 'trailing <mat-icon> inside a mat-*button → add iconPositionEnd (auto-fixable)' });
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, project.files(...TEMPLATES), (text) => {
      for (const t of trailingButtonIcons(text).reverse()) text = `${text.slice(0, t.insertAt)} iconPositionEnd${text.slice(t.insertAt)}`;
      return text;
    });
  },
};

const perfectScrollbarHeight: Rule = {
  id: 'deps/perfect-scrollbar-content',
  hop: 'v15+',
  title: 'perfect-scrollbar containers around expanding content',
  since: 15,
  hint: 'ngx-perfect-scrollbar / ngx-om-perfect-scrollbar do not recalculate their height when wrapped content expands (accordions, sub-menus) after the MDC switch. A native overflow-y: auto container is simpler and always correct.',
  check({ project }) {
    const pkgs = ['ngx-perfect-scrollbar', 'ngx-om-perfect-scrollbar'].filter((p) => project.declaredDeps[p]);
    if (!pkgs.length) return [];
    const uses = project.files(...TEMPLATES).filter((f) => /perfect-scrollbar|\[perfectScrollbar\]|\bperfectScrollbar\b/.test(project.read(f)));
    return pkgs.flatMap((p) => depFinding(project, p, `used in ${uses.length} template(s) — prefer native overflow-y: auto for expanding content`));
  },
};

const VSCODE_SETTINGS = {
  'files.watcherExclude': { '**/node_modules/**': true, '**/.angular/**': true, '**/dist/**': true, '**/.git/objects/**': true },
  'search.exclude': { '**/node_modules': true, '**/.angular': true, '**/dist': true },
  'typescript.tsserver.maxTsServerMemory': 3072,
  'typescript.disableAutomaticTypeAcquisition': true,
};

/** Merges the doctor's VS Code settings into .vscode/settings.json (keeps the user's own keys). */
export function writeVsCodeSettings(project: Project): string {
  const file = '.vscode/settings.json';
  const current = project.readJson(file) || {};
  const merged: Record<string, any> = { ...current };
  for (const [k, v] of Object.entries(VSCODE_SETTINGS)) {
    merged[k] = typeof v === 'object' && current[k] && typeof current[k] === 'object' ? { ...v, ...current[k] } : current[k] ?? v;
  }
  project.writeJson(file, merged);
  return file;
}

const vscodeWatcher: Rule = {
  id: 'workspace/vscode-watcher-exclude',
  hop: 'every hop',
  title: 'VS Code watches node_modules/.angular/dist',
  since: 6,
  hint: 'On big Angular workspaces VS Code\'s file watcher and tsserver can grow past 2 GB and crash the extension host. `ngx-upgrade-doctor vscode` writes .vscode/settings.json with files.watcherExclude, search.exclude, typescript.tsserver.maxTsServerMemory 3072 and disableAutomaticTypeAcquisition.',
  check({ project }) {
    const settings = project.readJson('.vscode/settings.json') || {};
    const ex = settings['files.watcherExclude'] || {};
    return Object.keys(ex).some((k) => k.includes('node_modules')) ? [] : [{ message: 'no files.watcherExclude for node_modules/.angular/dist — run `ngx-upgrade-doctor vscode`' }];
  },
};

/** Components declared by more than one NgModule, keyed by the file that defines them. */
export function componentsInSeveralModules(project: Project): Array<{ name: string; modules: Array<{ file: string; line: number }> }> {
  const byClass = new Map<string, { name: string; modules: Array<{ file: string; line: number }> }>();
  for (const file of tsFiles(project)) {
    const text = project.read(file);
    if (!/@NgModule\b/.test(text) || !/\bdeclarations\s*:/.test(text)) continue;
    const imports = new Map<string, string>();
    const re = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      for (const part of m[1].split(',')) {
        const [imported, local] = part.trim().split(/\s+as\s+/);
        if (imported) imports.set((local || imported).trim(), path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2])));
      }
    }
    for (const arr of metadataArrays(file, text).filter((a) => a.owner === 'NgModule' && a.prop === 'declarations')) {
      for (const el of arr.elements) {
        if (!ts.isIdentifier(el)) continue;
        const key = `${imports.get(el.text) || file}#${el.text}`;
        if (!byClass.has(key)) byClass.set(key, { name: el.text, modules: [] });
        const entry = byClass.get(key)!;
        if (!entry.modules.some((x) => x.file === file)) entry.modules.push({ file, line: nodeLine(el, arr.source) });
      }
    }
  }
  return [...byClass.values()].filter((c) => c.modules.length > 1);
}

const componentInTwoModules: Rule = {
  id: 'core/component-in-two-modules',
  hop: 'every hop',
  title: 'The same component declared in two NgModules',
  since: 6,
  removedIn: 6,
  hint: 'Angular fails with "Type X is part of the declarations of 2 modules" as soon as both modules are compiled. Declare it in one module (often a SharedModule) and export it from there, or make it standalone.',
  check({ project }) {
    const graph = buildGraph(project);
    const out: RawFinding[] = [];
    for (const c of componentsInSeveralModules(project)) {
      const live = graph ? c.modules.filter((m) => graph.has(m.file)) : c.modules;
      for (const mod of c.modules) {
        out.push({
          file: mod.file, line: mod.line,
          // Only a build error once two of those modules are actually compiled.
          ...(live.length < 2 ? { severity: 'warning' as const } : {}),
          message: `${c.name} is also declared in ${c.modules.filter((x) => x !== mod).map((x) => x.file).join(', ')}${live.length < 2 ? " (not both in the build graph today; it fails as soon as they are)" : ''}`,
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// v15-17: MDC slider, library API changes, peers skipped by --legacy-peer-deps
// ---------------------------------------------------------------------------

/** Value bindings that move from <mat-slider> to its <input matSliderThumb>. */
const SLIDER_THUMB_ATTRS = /^(\[\(ngModel\)\]|\[ngModel\]|ngModel|\(ngModelChange\)|\[ngModelOptions\]|\[value\]|value|\(change\)|\(input\)|\(valueChange\)|formControlName|\[formControlName\]|\[formControl\]|name)$/;

/**
 * Rewrites a pre-MDC <mat-slider> to the v15+ API: thumbLabel → discrete, tickInterval → showTickMarks,
 * value/ngModel/form bindings and change events onto a child <input matSliderThumb>. Undefined when the
 * slider needs a human (it already has content, or uses vertical/invert, which MDC dropped).
 */
export function migrateSliderTag(attrs: string, content: string): string | undefined {
  if (content.trim() || /\s\[?(vertical|invert)\]?(?=[\s=>]|$)/.test(attrs)) return undefined;
  const parts: Array<{ name: string; raw: string }> = [];
  const re = /\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) parts.push({ name: m[1], raw: m[0].trim() });
  const slider: string[] = [];
  const thumb: string[] = [];
  for (const p of parts) {
    if (SLIDER_THUMB_ATTRS.test(p.name)) thumb.push(p.raw);
    else if (p.name === 'thumbLabel') slider.push('discrete');
    else if (p.name === '[thumbLabel]') slider.push(p.raw.replace('[thumbLabel]', '[discrete]'));
    else if (/^\[?tickInterval\]?$/.test(p.name)) slider.push('showTickMarks');
    else slider.push(p.raw);
  }
  if (!thumb.length && !parts.some((p) => /^(thumbLabel|\[thumbLabel\]|\[?tickInterval\]?)$/.test(p.name))) return undefined;
  return `<mat-slider${slider.length ? ` ${slider.join(' ')}` : ''}>${thumb.length ? `<input matSliderThumb ${thumb.join(' ')}>` : ''}</mat-slider>`;
}

const SLIDER = /<mat-slider\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/mat-slider\s*>/g;

/** Pre-MDC sliders in a template: bindings on <mat-slider> itself, or thumbLabel/tickInterval. */
export function legacySliders(text: string): Array<{ offset: number; end: number; replacement?: string }> {
  const out: Array<{ offset: number; end: number; replacement?: string }> = [];
  const re = new RegExp(SLIDER.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (/matSliderThumb|matSliderStartThumb/.test(m[2])) continue;
    const legacy = /\s(thumbLabel|\[thumbLabel\]|\[?tickInterval\]?|\[\(ngModel\)\]|\[ngModel\]|\[value\]|formControlName|\[formControl\]|\(change\)|\(input\)|vertical|invert)(?=[\s=>]|$)/.test(m[1]);
    if (!legacy) continue;
    out.push({ offset: m.index, end: m.index + m[0].length, replacement: migrateSliderTag(m[1], m[2]) });
  }
  return out;
}

const mdcSlider: Rule = {
  id: 'material/mdc-slider',
  hop: 'v15-17',
  title: 'mat-slider uses the pre-MDC API (thumbLabel, tickInterval, bindings on <mat-slider>)',
  since: 15,
  deprecatedIn: 15,
  removedIn: 17,
  fixRequires: 15,
  hint: 'The MDC slider takes its value from a child <input matSliderThumb>: thumbLabel → discrete, tickInterval → showTickMarks, and [(ngModel)]/[value]/formControlName/(change) move onto the input. vertical and invert are gone. The auto-fix rewrites sliders without content.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files(...TEMPLATES)) {
      const text = project.read(file);
      if (!text.includes('<mat-slider')) continue;
      // A template whose component is outside the build graph does not break the build today.
      const component = file.replace(/.html$/, '.ts');
      const dead = project.exists(component) ? deadCodeNote(project, component) : '';
      for (const s of legacySliders(text)) {
        out.push({ file, line: lineOf(text, s.offset), fixable: !!s.replacement,
          ...(dead ? { severity: 'warning' as const } : {}),
          message: `${s.replacement ? 'pre-MDC <mat-slider> → <input matSliderThumb> child' : 'pre-MDC <mat-slider> with content or vertical/invert — migrate by hand'}${dead}${s.replacement ? ' (auto-fixable)' : ' (manual)'}` });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, project.files(...TEMPLATES), (text) => {
      for (const s of legacySliders(text).reverse()) if (s.replacement) text = text.slice(0, s.offset) + s.replacement + text.slice(s.end);
      return text;
    });
  },
};

/** Libraries whose module lost forRoot(): from this version on, import the module itself. */
const FOR_ROOT_REMOVED: Array<{ pkg: string; module: string; from: string }> = [
  { pkg: 'ngx-material-timepicker', module: 'NgxMaterialTimepickerModule', from: '13.0.0' },
];

const forRootRemoved: Rule = {
  id: 'deps/for-root-removed',
  hop: 'v15-16',
  title: 'Library modules whose .forRoot() was removed',
  since: 6,
  removedIn: 6,
  fixRequires: 6,
  hint: 'ngx-material-timepicker 13 (the Ivy release needed for Angular 16) dropped NgxMaterialTimepickerModule.forRoot(); the call fails to compile. The auto-fix imports the module itself.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const r of FOR_ROOT_REMOVED) {
      const v = project.installedVersion(r.pkg) || project.declaredDeps[r.pkg];
      const min = v && (semver.valid(v) || (semver.minVersion(v) || { version: '' }).version);
      if (!min || semver.lt(min, r.from)) continue;
      out.push(...scanFiles(project, tsFiles(project), new RegExp(`\\b${r.module}\\.forRoot\\(\\s*\\)`), `${r.module}.forRoot() no longer exists in ${r.pkg} ${r.from}+ → ${r.module} (auto-fixable)`));
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text) => FOR_ROOT_REMOVED.reduce((t, r) => t.replace(new RegExp(`\\b${r.module}\\.forRoot\\(\\s*\\)`, 'g'), r.module), text));
  },
};

const buildAngularPeers: Rule = {
  id: 'deps/build-angular-peers',
  hop: 'every hop',
  title: 'Builder peer dependencies missing (installed with --legacy-peer-deps)',
  since: 6,
  removedIn: 6,
  hint: 'npm --legacy-peer-deps skips peer dependencies, so @angular-devkit/build-angular can be left without the webpack it needs ("Cannot find module \'webpack\'"). Install the listed peers explicitly as devDependencies.',
  check({ project }) {
    const devkit = path.join(project.root, 'node_modules', '@angular-devkit', 'build-angular', 'package.json');
    if (!fs.existsSync(devkit) || !buildTargets(project).some((t) => /build-angular:(browser|karma|dev-server)|custom-webpack/.test(t.builder))) return [];
    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(devkit, 'utf8'));
    } catch {
      return [];
    }
    const peers: Record<string, string> = pkg.peerDependencies || {};
    const optional: Record<string, any> = pkg.peerDependenciesMeta || {};
    return ['webpack', 'webpack-dev-server']
      .filter((name) => peers[name] && !(optional[name] && optional[name].optional) && !project.installedVersion(name))
      .map((name) => ({ file: 'package.json', message: `${name} is a peer of @angular-devkit/build-angular@${pkg.version} but is not installed → npm i -D "${name}@${peers[name]}"` }));
  },
};

const perfectScrollbarFork: Rule = {
  id: 'deps/perfect-scrollbar-fork',
  hop: 'v15-16',
  title: 'ngx-perfect-scrollbar → ngx-om-perfect-scrollbar (Ivy fork, same API)',
  since: 16,
  removedIn: 16,
  fixRequires: 6,
  hint: 'ngx-perfect-scrollbar is a View Engine library and stops working once ngcc is gone (v16). ngx-om-perfect-scrollbar is a drop-in fork: the auto-fix swaps the dependency and rewrites the imports. For content that expands, native overflow-y: auto is simpler (deps/perfect-scrollbar-content).',
  check({ project }) {
    const out: RawFinding[] = depFinding(project, 'ngx-perfect-scrollbar', 'View Engine, abandoned → ngx-om-perfect-scrollbar@^16.0.0 (auto-fixable)');
    out.push(...scanFiles(project, tsFiles(project), /(['"])ngx-perfect-scrollbar\1/, "import from 'ngx-perfect-scrollbar' → 'ngx-om-perfect-scrollbar' (auto-fixable)"));
    return out;
  },
  fix({ project }) {
    if (project.declaredDeps['ngx-perfect-scrollbar']) swapDep(project, 'ngx-perfect-scrollbar', 'ngx-om-perfect-scrollbar', '^16.0.0');
    transformFiles(project, tsFiles(project), (text) => text.replace(/(['"])ngx-perfect-scrollbar\1/g, '$1ngx-om-perfect-scrollbar$1'));
  },
};

/**
 * `x.subscribe(next, error[, complete])` calls — the callback overloads RxJS 7 deprecated. With `single`,
 * also `x.subscribe(v => …)` with one inline callback (not deprecated; observer style by choice). A single
 * argument that is not an inline function may be an observer or a Subject, so it is never touched.
 */
export function multiCallbackSubscribes(file: string, text: string, single = false): Array<{ start: number; end: number; observer: string; line: number }> {
  if (!/\.subscribe\s*\(/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Array<{ start: number; end: number; observer: string; line: number }> = [];
  const empty = (e: ts.Expression): boolean => e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
  const visit = (node: ts.Node): void => {
    const call = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'subscribe';
    const args = call ? (node as ts.CallExpression).arguments : undefined;
    const singleInline = single && !!args && args.length === 1 && (ts.isArrowFunction(args[0]) || ts.isFunctionExpression(args[0]));
    if (call && args && ((args.length > 1 && args.length <= 3) || singleInline)) {
      const parts = ['next', 'error', 'complete']
        .map((key, i) => (args[i] && !empty(args[i]) ? `${key}: ${args[i].getText(source)}` : ''))
        .filter(Boolean);
      out.push({ start: args[0].getStart(source), end: args[args.length - 1].getEnd(), observer: `{ ${parts.join(', ')} }`, line: nodeLine(node as ts.CallExpression, source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Rewrites deprecated callback subscribes to an observer object; inner calls first, so nesting stays valid. */
export function migrateSubscribeCallbacks(file: string, text: string, single = false): string {
  // Each pass rewrites the innermost calls (those containing no other match), then re-parses.
  for (let guard = 0; guard < 20; guard++) {
    const calls = multiCallbackSubscribes(file, text, single);
    if (!calls.length) return text;
    const innermost = calls.filter((c) => !calls.some((o) => o !== c && o.start >= c.start && o.end <= c.end));
    for (const c of innermost.sort((a, b) => b.start - a.start)) text = text.slice(0, c.start) + c.observer + text.slice(c.end);
  }
  return text;
}

/** Opt-in: every inline callback subscribe in observer style. Suggestion only; the fix runs when named with --only. */
const subscribeObserverStyle: Rule = {
  id: 'rxjs/subscribe-observer-style',
  hop: 'v12+',
  title: 'subscribe(v => …) → subscribe({ next: v => … }) (observer style, opt-in)',
  since: 12,
  level: 'info',
  fixRequires: 6,
  hint: 'Not a deprecation: a single callback is still valid in RxJS 7. Some teams want every subscription in observer style, so adding error/complete later is a one-line change. Apply with `ngx-upgrade-doctor current --fix --only rxjs/subscribe-observer-style` (it also converts the deprecated multi-callback calls). Only inline callbacks are converted; subscribe(observer) and subscribe(subject) are left alone.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      const calls = multiCallbackSubscribes(file, text, true);
      if (calls.length) out.push({ file, line: calls[0].line, message: `${calls.length} subscribe(callback) call(s) → subscribe({ next: … }) (auto-fixable with --only)` });
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text, file) => migrateSubscribeCallbacks(file, text, true));
  },
};

const subscribeCallbacks: Rule = {
  id: 'rxjs/subscribe-callbacks',
  hop: 'v12+',
  title: 'subscribe(next, error, complete) callbacks are deprecated in RxJS 7',
  since: 12,
  deprecatedIn: 12,
  fixRequires: 6,
  hint: 'RxJS 7 deprecates passing several callbacks: subscribe(data => ..., err => ...) → subscribe({ next: data => ..., error: err => ... }). A single callback, subscribe(data => ...), is still fine. The auto-fix rewrites the calls to an observer object (it works on RxJS 6 too).',
  check({ project }) {
    const rxjs = project.versionOf('rxjs');
    if (!rxjs || semver.major(rxjs) < 7) return [];
    const out: RawFinding[] = [];
    for (const file of tsFiles(project)) {
      const text = project.read(file);
      const calls = multiCallbackSubscribes(file, text);
      if (calls.length) out.push({ file, line: calls[0].line, message: `${calls.length} subscribe(next, error…) call(s) → subscribe({ next, error }) (auto-fixable)` });
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, tsFiles(project), (text, file) => migrateSubscribeCallbacks(file, text));
  },
};

const CHIP_LIST = /<mat-chip-list\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/mat-chip-list\s*>/g;

/**
 * <mat-chip-list> blocks (removed with the legacy chips in v17). Display-only lists become <mat-chip-set>;
 * lists with an input or selection need mat-chip-grid / mat-chip-listbox and stay manual.
 */
export function legacyChipLists(text: string): Array<{ offset: number; end: number; replacement?: string }> {
  const out: Array<{ offset: number; end: number; replacement?: string }> = [];
  const re = new RegExp(CHIP_LIST.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const interactive = /matChipInputFor|\[?selectable\]?|\(selectionChange\)|\[\(ngModel\)\]|formControlName|\[formControl\]|\bmultiple\b|\(removed\)|\(remove\)/.test(m[1] + m[2]);
    out.push({
      offset: m.index, end: m.index + m[0].length,
      replacement: interactive ? undefined : `<mat-chip-set${m[1]}>${m[2]}</mat-chip-set>`,
    });
  }
  return out;
}

const mdcChipList: Rule = {
  id: 'material/mdc-chip-list',
  hop: 'v15-17',
  title: '<mat-chip-list> was removed with the legacy chips (v17) — chips lose their layout',
  since: 15,
  deprecatedIn: 15,
  fixRequires: 15,
  hint: 'The MDC chips have three containers: <mat-chip-set> for display-only chips, <mat-chip-listbox> + <mat-chip-option> for selection, <mat-chip-grid> + <mat-chip-row> + matChipInputFor for input. A leftover <mat-chip-list> is just an unknown wrapper, so its chips lose their layout (wrapping, spacing). The auto-fix turns display-only lists into <mat-chip-set>; selection/input lists need a hand.',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of project.files(...TEMPLATES)) {
      const text = project.read(file);
      if (!text.includes('<mat-chip-list')) continue;
      // It still compiles (an unknown wrapper), so this is a layout regression, not a build break.
      for (const c of legacyChipLists(text)) {
        out.push({
          file, line: lineOf(text, c.offset), fixable: !!c.replacement,
          message: c.replacement ? '<mat-chip-list> → <mat-chip-set> (auto-fixable)' : '<mat-chip-list> with input/selection → mat-chip-grid or mat-chip-listbox by hand (manual)',
        });
      }
    }
    out.push(...scanFiles(project, tsFiles(project), /\bMatChipList\b(?!box)/, 'MatChipList (removed) → MatChipListbox / MatChipGrid / MatChipSet (manual)').map((f) => ({ ...f, fixable: false })));
    return out;
  },
  fix({ project }) {
    transformFiles(project, project.files(...TEMPLATES), (text) => {
      for (const c of legacyChipLists(text).reverse()) if (c.replacement) text = text.slice(0, c.offset) + c.replacement + text.slice(c.end);
      return text;
    });
  },
};

/** Sass-only syntax in a plain .css file: $variables, @use/@include/@mixin/@if…, `//` line comments. (`&` nesting is valid CSS now.) */
const SASS_IN_CSS = /^\s*\$[\w-]+\s*:|^\s*@(use|forward|include|mixin|extend|function|if|each|for)\b|^\s*\/\/(?!\s*#\s*source)/m;

/** Component .css files that are really Sass, with the components that reference them. */
export function sassInCssFiles(project: Project): Array<{ file: string; line: number; users: string[] }> {
  const out: Array<{ file: string; line: number; users: string[] }> = [];
  const css = project.files('.css').filter((f) => !f.includes('/assets/'));
  if (!css.length) return out;
  const ts = tsFiles(project);
  for (const file of css) {
    const text = project.read(file).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/url\([^)]*\)/g, 'url()');
    const m = SASS_IN_CSS.exec(text);
    if (!m) continue;
    const base = path.posix.basename(file);
    const users = ts.filter((t) => path.posix.dirname(t) === path.posix.dirname(file) && project.read(t).includes(base));
    out.push({ file, line: lineOf(text, m.index + m[0].search(/\S/)), users });
  }
  return out;
}

const sassInCss: Rule = {
  id: 'build/sass-in-css',
  hop: 'v17+',
  title: 'Sass syntax in a .css file (esbuild reads it as plain CSS)',
  since: 17,
  deprecatedIn: 17,
  fixRequires: 6,
  hint: 'The application builder treats .css as CSS, so Sass variables, @include or nesting in it fail with "Unexpected \\"$\\"" and those rules are dropped (webpack setups sometimes ran every stylesheet through Sass). The auto-fix renames the file to .scss and updates the component\'s styleUrl/styleUrls.',
  check({ project }) {
    return sassInCssFiles(project).map((s) => ({
      file: s.file, line: s.line, fixable: s.users.length > 0,
      message: s.users.length ? `Sass in a .css file → rename to .scss (used by ${s.users.join(', ')}) (auto-fixable)` : 'Sass in a .css file, not referenced by a component next to it — rename and update its reference by hand (manual)',
    }));
  },
  fix({ project }) {
    for (const s of sassInCssFiles(project)) {
      if (!s.users.length) continue;
      const target = s.file.replace(/\.css$/, '.scss');
      if (project.exists(target)) continue;
      project.write(target, project.read(s.file));
      project.remove(s.file);
      const base = path.posix.basename(s.file);
      for (const u of s.users) project.write(u, project.read(u).split(base).join(path.posix.basename(target)));
    }
  },
};

/** Dependencies listed in package.json but missing from node_modules (e.g. after a fix swapped a library). */
export function notInstalled(project: Project): string[] {
  if (!fs.existsSync(path.join(project.root, 'node_modules'))) return [];
  const deps = project.declaredDeps;
  return Object.keys(deps).filter((n) => !/^(file|link|git|github|https?):|^\.{0,2}\//.test(deps[n]) && project.installedVersion(n) === undefined);
}

const packagesNotInstalled: Rule = {
  id: 'deps/not-installed',
  hop: 'every hop',
  title: 'Packages in package.json that are not installed',
  since: 6,
  removedIn: 6,
  hint: 'After `fix` or `deps` changed package.json (e.g. ngx-material-timepicker → ngx-mat-timepicker, flex-layout → @ngbracket/ngx-layout), run npm install before building, or the build fails with "Could not resolve" / TS2307. Use --legacy-peer-deps if npm reports peer conflicts.',
  check({ project }) {
    const missing = notInstalled(project);
    if (!missing.length) return [];
    const text = project.read('package.json');
    return [{
      file: 'package.json', line: lineOf(text, Math.max(0, text.indexOf(`"${missing[0]}"`))),
      message: `${missing.length} declared package(s) not installed: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''} → npm install (--legacy-peer-deps on peer conflicts)`,
    }];
  },
};

/** @angular-devkit/build-angular builders that have an @angular/build equivalent. */
const NEW_BUILDERS: Record<string, string> = {
  '@angular-devkit/build-angular:application': '@angular/build:application',
  '@angular-devkit/build-angular:dev-server': '@angular/build:dev-server',
  '@angular-devkit/build-angular:extract-i18n': '@angular/build:extract-i18n',
};

const deprecatedBuildAngular: Rule = {
  id: 'build/build-angular-package',
  hop: 'v20+',
  title: '@angular-devkit/build-angular builders are deprecated — use @angular/build',
  since: 20,
  deprecatedIn: 20,
  fixRequires: 20,
  hint: '"The @angular-devkit/build-angular:dev-server builder is deprecated as part of Angular\'s Webpack support deprecation." The esbuild builders moved to the lighter @angular/build package with the same options. The auto-fix renames application/dev-server/extract-i18n builders and adds @angular/build to devDependencies (run npm install afterwards). Karma/webpack-based targets stay on build-angular until you migrate them.',
  check({ project }) {
    const text = project.exists('angular.json') ? project.read('angular.json') : '';
    return scanFiles(project, text ? ['angular.json'] : [], new RegExp(`"(${Object.keys(NEW_BUILDERS).join('|').replace(/[/:.-]/g, (c) => `\\${c}`)})"`),
      (m) => `"${m[1]}" → "${NEW_BUILDERS[m[1]]}" (auto-fixable)`);
  },
  fix({ project, version }) {
    let text = project.read('angular.json');
    for (const [from, to] of Object.entries(NEW_BUILDERS)) text = text.split(`"${from}"`).join(`"${to}"`);
    project.write('angular.json', text);
    addDevDep(project, '@angular/build', `^${version}.0.0`);
  },
};

const devServerSettings: Rule = {
  id: 'build/dev-server-settings',
  hop: 'v17+',
  title: 'Dev-server settings that slow down ng serve (HMR off, build cache off)',
  since: 17,
  level: 'warning',
  hint: 'outputHashing "all" in the configuration ng serve uses turns off Hot Module Replacement; set "outputHashing": "none" there, or serve a dedicated development configuration (keep hashing in configurations you deploy). With "cli": { "cache": { "enabled": false } } the dev server cannot pre-bundle dependencies, so every rebuild is slower.',
  check({ project }) {
    const ws = project.readJson('angular.json') || {};
    const out: RawFinding[] = [];
    if (ws.cli && ws.cli.cache && ws.cli.cache.enabled === false) out.push({ file: 'angular.json', message: 'cli.cache.enabled is false — the dev server cannot pre-bundle dependencies (slower ng serve)' });
    for (const [name, p] of Object.entries<any>(ws.projects || {})) {
      const targets = (p && (p.architect || p.targets)) || {};
      const serve = targets.serve;
      const build = targets.build;
      if (!serve || !build || !/dev-server$/.test(String(serve.builder || '')) || !/:application$/.test(String(build.builder || ''))) continue;
      const configs = new Set<string>([String(serve.defaultConfiguration || 'development'), ...Object.keys(serve.configurations || {})]);
      for (const c of configs) {
        // Serving a production build is deliberate; hashing belongs there.
        if (/^prod(uction)?$/i.test(c)) continue;
        const target = String(((serve.configurations || {})[c] || {}).buildTarget || `${name}:build:${c}`);
        const buildConfig = target.split(':')[2] || '';
        const hashing = ((build.configurations || {})[buildConfig] || {}).outputHashing ?? (build.options || {}).outputHashing;
        if (hashing === 'all') out.push({ file: 'angular.json', message: `${name}: ng serve --configuration ${c} builds with outputHashing "all" — HMR is disabled; use "none" for serving` });
      }
    }
    return out;
  },
};

/** Top-level node_modules package names (scoped ones as @scope/name). */
function topLevelPackages(project: Project): string[] {
  const nm = path.join(project.root, 'node_modules');
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(nm);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    if (e.startsWith('@')) {
      try {
        for (const s of fs.readdirSync(path.join(nm, e))) out.push(`${e}/${s}`);
      } catch {
        // not a folder
      }
    } else out.push(e);
  }
  return out;
}

export interface InvalidInstall {
  /** The package npm ls calls invalid, e.g. rxjs@7.8.2. */
  name: string;
  installed: string;
  /** Who wants something else. */
  requiredBy: Array<{ pkg: string; version: string; range: string; peer: boolean }>;
}

/**
 * What `npm ls` reports as "invalid": a direct dependency whose installed version does not satisfy the range
 * another installed package asks for (dependencies or required peerDependencies) and that has no nested copy.
 * `ng update` stops on these (npm error code ELSPROBLEMS) before installing anything.
 */
export function invalidInstalls(project: Project): InvalidInstall[] {
  const nm = path.join(project.root, 'node_modules');
  if (!fs.existsSync(nm)) return [];
  const direct = Object.keys(project.declaredDeps);
  const installed = new Map<string, string>();
  for (const d of direct) {
    const v = project.installedVersion(d);
    if (v) installed.set(d, v);
  }
  const found = new Map<string, InvalidInstall>();
  for (const pkg of topLevelPackages(project)) {
    let meta: any;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const optionalPeers = meta.peerDependenciesMeta || {};
    const wants: Array<[string, string, boolean]> = [
      ...Object.entries<string>(meta.dependencies || {}).map(([n, r]): [string, string, boolean] => [n, r, false]),
      ...Object.entries<string>(meta.peerDependencies || {}).filter(([n]) => !(optionalPeers[n] && optionalPeers[n].optional)).map(([n, r]): [string, string, boolean] => [n, r, true]),
    ];
    for (const [dep, range, peer] of wants) {
      const v = installed.get(dep);
      if (!v || dep === pkg || !semver.validRange(range)) continue;
      // A nested copy satisfies the dependency; npm ls only flags the hoisted one when nothing else serves it.
      if (!peer && fs.existsSync(path.join(nm, pkg, 'node_modules', dep, 'package.json'))) continue;
      if (semver.satisfies(v, range, { includePrerelease: true })) continue;
      if (!found.has(dep)) found.set(dep, { name: dep, installed: v, requiredBy: [] });
      found.get(dep)!.requiredBy.push({ pkg, version: String(meta.version || '?'), range, peer });
    }
  }
  return [...found.values()];
}

const invalidInstalled: Rule = {
  id: 'deps/invalid-installed',
  hop: 'every hop',
  title: 'Installed packages npm calls "invalid" (ng update stops with ELSPROBLEMS)',
  since: 6,
  // Builds still work; it is the next `ng update` that stops — deps --apply checks it up front.
  level: 'warning',
  hint: 'ng update runs `npm ls` before it installs anything and stops on "invalid" packages (npm error code ELSPROBLEMS) — --force does not skip it. Upgrade or uninstall the package that asks for the other version (`ngx-upgrade-doctor deps --online` suggests one), then `npm install --legacy-peer-deps`. `npm ls <name>` shows the same tree.',
  check({ project }) {
    const text = project.read('package.json');
    return invalidInstalls(project).map((i) => ({
      file: 'package.json', line: lineOf(text, Math.max(0, text.indexOf(`"${i.name}"`))),
      message: `${i.name}@${i.installed} is invalid for npm: ${i.requiredBy.map((r) => `${r.pkg}@${r.version} wants ${r.range}${r.peer ? ' (peer)' : ''}`).join('; ')} → upgrade or uninstall ${i.requiredBy.map((r) => r.pkg).join(', ')}`,
    }));
  },
};

const cliTempFoldersRule: Rule = {
  id: 'deps/cli-temp-folders',
  hop: 'every hop',
  title: 'Leftover angular-cli-tmp-packages-* folders from an interrupted ng update',
  since: 6,
  removedIn: 6,
  fixRequires: 6,
  hint: 'An interrupted `ng update` leaves node_modules/angular-cli-tmp-packages-*. npm ls calls them "extraneous" and the next ng update stops with ELSPROBLEMS. They are the CLI\'s own temp folders — the auto-fix deletes them.',
  check({ project }) {
    return project.exists('node_modules')
      ? fs.readdirSync(path.join(project.root, 'node_modules')).filter((n) => /^angular-cli-tmp-packages-/.test(n))
        .map((n) => ({ file: `node_modules/${n}`, message: `leftover ${n} → removed (auto-fixable)` }))
      : [];
  },
  fix({ project }) {
    if (!project.exists('node_modules')) return;
    for (const n of fs.readdirSync(path.join(project.root, 'node_modules')).filter((x) => /^angular-cli-tmp-packages-/.test(x))) {
      project.remove(`node_modules/${n}`);
    }
  },
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
  knownIncompatible, coreJsPolyfills, flexLayout, classGuards, materialLegacy, mdcSelectors, themePositional, nguniversal, controlFlow, standalone, applicationBuilder,
  duplicateMetadata, httpClientModule, templateStyleUrl, sassModuleSystem, commonDirectiveConstructors, controlFlowAutoMigration, structuralTrailingSeparator, invalidTemplateHtml,
  uint8ArrayBufferSource, relativeLinksAboveRoot, tsStrictDefault, tsCalledNamespaceImport, tsDeprecatedOptions,
  removedAngularApis, libraryApiRenames, loopVariableIn, conflictingButtons, extendedDiagnosticsWithoutStrictTemplates, esbuildExternalDependencies, jspdfBreakingApi,
  fileNameCase, packageScripts, applicationBuilderOutput, mdcSlider, forRootRemoved, buildAngularPeers, perfectScrollbarFork, subscribeCallbacks, subscribeObserverStyle, mdcChipList, sassInCss, packagesNotInstalled, deprecatedBuildAngular, devServerSettings, invalidInstalled, cliTempFoldersRule, buttonTrailingIcon, perfectScrollbarHeight, vscodeWatcher, componentInTwoModules,
  animationsPackage, zoneless, karma, explicitTypes,
];
