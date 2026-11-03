# Changelog

## 0.5.1

- package.json: repository, homepage, issues and author links (shown on the npm page) and a `funding` entry (GitHub Sponsors, listed by `npm fund`).
- README: sponsor badge, "Support the project" and "Professional help" sections.

## 0.5.0

- New `finalize` command: the final touch for an Angular 22 workspace, after an upgrade that went well or not. It (1) installs library versions compatible with the installed Angular (`deps --online --apply`), (2) applies every auto-fix that applies to the installed version, from any earlier hop: styles, Material/MDC, Sass, templates, RxJS, builder and tsconfig, plus the opt-in `rxjs/subscribe-observer-style`, (3) asks for the types pass, (4) clears `.angular/cache` and (5) reports what is left (rules, template parse errors, TypeScript). Options: `--yes`, `--dry-run`, `--skip-deps`, `--skip-types`, `--offline`, `--no-tsc`, `--mode`.
- New types mode `nullable` (`types --mode nullable`): adds `: any` only to the untyped local variables, callback parameters and `catch` variables that strict null checks report as possibly `undefined`/`null`/`unknown` (TS18048, TS18047, TS18049, TS2531, TS2532, TS2533, TS18046). Typical sources are `await obs.toPromise()` (`T | undefined` in RxJS 7) and `subscribe(res => res.data)`.
- `strict` and `strict --enable` fix the same errors (new fix kind `possibly-undefined`): `const res = …` → `const res: any = …`, `res => …` → `(res: any) => …`, `catch (e)` → `catch (e: any)`. Explicitly typed declarations and `for…of` variables are left alone and listed.
- Misaligned screens after the MDC rewrite (v15+):
  - `material/mdc-style-overrides` now auto-fixes: overrides of ~100 old internal Material classes (form field, select, option, buttons, checkbox, radio, slide toggle, tabs, chips, list, card, dialog, menu, tooltip, paginator, table) are renamed to their MDC classes in stylesheets and inline component `styles`. Classes the templates use literally are kept, nothing is renamed while `MatLegacy*` components are imported, and classes with no MDC equivalent are listed. Matching is exact, so `.mat-button-toggle` or `.mat-tooltip-panel` are no longer flagged by mistake.
  - New `material/form-field-appearance` (auto-fix): removes `appearance="legacy"`/`"standard"` and `floatLabel="never"` (template attributes and bound literals) and maps them to `fill`/`auto` in `MAT_FORM_FIELD_DEFAULT_OPTIONS`.
  - New opt-in `material/select-selection-indicator` (auto-fix, applied by `finalize`): adds `hideSingleSelectionIndicator` to single-selection `mat-select`/`mat-autocomplete`, removing the v16+ ✓ on the selected option.
  - New `material/input-in-option`: flags a search `<input>` inside `<mat-option>`.
  - `ngx-mat-select-search` is a known breaker: `<7` on v15+ (built for the legacy select: blank row, grey box above the options) → `^7.0.0`; `<9.0.0` on v22 → the latest `^9.0.0`.
- `deps --apply` says "Nothing to run" when the dependencies already fit, instead of running an empty plan.
- README rewritten as standard documentation: features, requirements, installation, quick start, finalizing, and generic examples.

## 0.4.2

- After `fix` / `current --fix` changes package.json (library swaps such as ngx-mat-timepicker or @ngbracket/ngx-layout, `@angular/build`), the CLI now asks to run `npm install` at once. `--install` runs it without asking and `--legacy-peer-deps` is passed through. Non-interactive runs print the exact command, and dry runs stay silent. The follow-up check re-reads node_modules, so `deps/not-installed` is accurate.
- New `strict --enable` (with `--force`): type-checks as if `"strict": true`, fixes what that breaks (the same TS2564/TS2322/TS7053/TS7015/TS7016 fixes as `strict`), then turns strict mode on. It replaces `"strict": false` (or adds `"strict": true` to tsconfig.json) and removes explicit `false` strict-family flags. The tsconfig changes only when no errors remain, unless `--force`.
- New `deps/invalid-installed`: finds what `npm ls` calls "invalid" (e.g. `jspdf@1.5.3 invalid: "^2.5.1" from jspdf-autotable`) and names the package to upgrade or uninstall. `deps --apply` checks it before running anything and stops with that list, since `ng update` would stop with ELSPROBLEMS anyway; `--ignore-invalid` overrides.
- New `deps/cli-temp-folders` (auto-fix): removes leftover `angular-cli-tmp-packages-*` folders. Fixes can now delete folders, which respects `--dry-run`.
- `deps --apply` no longer runs `ng update @angular/core@N` on an app that is already on N: it updates only the Angular packages still behind (e.g. just `@angular/material@22` when Material is on 21). When nothing is behind, Angular-peer library bumps become plain `npm install`s.
- `deps --apply` runs removals **before** `ng update`. Stale libraries left node_modules "invalid" (e.g. `invalid: rxjs@7.8.2`), which made `ng update` stop with `ELSPROBLEMS`.
- `deps --apply` removes leftover `angular-cli-tmp-packages-*` folders from an interrupted `ng update` before running anything.
- When a command stops with npm's `ELSPROBLEMS`, the hint names the extraneous/invalid packages and the `npm ls <name>` to run, instead of suggesting `--ng-force` (which cannot skip it).
- The Node row says "Fits." when the running Node already fits, instead of suggesting a newer major.
- Every command the CLI prints starts with `npx ngx-upgrade-doctor`, which works without a global install.
- Every header shows the doctor's own version (`ngx-upgrade-doctor 0.4.2 · …`), so an older cached `npx` copy is easy to spot.

## 0.4.1

- New opt-in rule `rxjs/subscribe-observer-style` (auto-fix with `current --fix --only rxjs/subscribe-observer-style`): converts single inline-callback `subscribe(v => …)` to `subscribe({ next: v => … })` as well as the deprecated multi-callback form. It leaves `subscribe(observer)` and `subscribe(subject)` alone.
- The engine applies a suggestion-level (info) fix when its rule is named explicitly with `--only`.
- New `build/sass-in-css` (auto-fix): Sass written in a `.css` component stylesheet ("Unexpected \"$\"") is renamed to `.scss`, and `styleUrl(s)` are updated. Fixes can now delete files, which respects `--dry-run`.
- New `deps/not-installed`: packages in package.json that are not in node_modules, e.g. right after a fix swapped a library.
- New `build/build-angular-package` (auto-fix): deprecated `@angular-devkit/build-angular` esbuild builders → `@angular/build`.
- New `build/dev-server-settings`: `outputHashing: "all"` in the served configuration (HMR off) and a disabled build cache.

## 0.4.0

Everything in this release came from taking a real production app from Angular 16 to 22.2. Each item is a failure `ng build` or the browser hit while `scan` said nothing (or said the wrong thing).

### New rules

- **Every hop**
  - `deps/missing-packages`: imports of packages not in package.json. It is comment-aware (uses the TypeScript scanner); e2e/spec files are warnings.
  - `core/component-in-two-modules`: the same component declared in two NgModules. It's a blocker once both modules are in the build.
  - `build/file-name-case` (auto-fix): `templateUrl`, `styleUrl(s)`, relative imports and `url()` whose letter case differs from the file on disk. Linux CI fails on these, and esbuild warns `[different-path-case]`.
  - `build/package-scripts` (auto-fix):
    - removes webpack-only flags (`--build-optimizer`, `--vendor-chunk`, `--common-chunk`, `--deploy-url`) under the application builder;
    - warns on a duplicate `--configuration`;
    - inserts `--` after `npm run x` so npm stops swallowing the flags;
    - warns on a `--max_old_space_size` above RAM (or 16384 MB).
  - `deps/jspdf-2-breaking-api`: jspdf 1 APIs removed in 2 (`setFontStyle`, `fromHTML`, `text(..., 'center')`, …). `deps` reports jspdf 2 as **check**, never as an automatic upgrade.
  - `workspace/vscode-watcher-exclude` (info), plus the new `vscode` command that writes `.vscode/settings.json`.
- **v15–17**
  - `material/mdc-chip-list` (auto-fix): leftover `<mat-chip-list>` (removed in v17) → `<mat-chip-set>` for display-only chips; selection/input lists are manual.
  - `material/mdc-slider` (auto-fix): pre-MDC `mat-slider`. `thumbLabel` → `discrete`, `tickInterval` → `showTickMarks`, and value bindings move onto `<input matSliderThumb>`.
  - `deps/perfect-scrollbar-fork` (auto-fix): ngx-perfect-scrollbar → ngx-om-perfect-scrollbar@^16 (dependency swap and import rewrite).
  - `deps/for-root-removed` (auto-fix): `NgxMaterialTimepickerModule.forRoot()` with timepicker 13+.
  - `deps/build-angular-peers`: the `webpack` peer of `@angular-devkit/build-angular`, skipped by `--legacy-peer-deps`.
- **v13+**
  - `deps/known-incompatible`: libraries known to break on a given major — ngx-perfect-scrollbar (→ ngx-om-perfect-scrollbar), ngx-material-timepicker, ngx-webcam, ngx-image-cropper, ng2-pdf-viewer, angular-calendar (0.31 for v16, 0.32 for v22), @swimlane/ngx-charts, date-fns.
- **v15+**
  - `polyfills/core-js-unneeded` (auto-fix): removes `core-js/es*` polyfill imports.
  - `material/theme-positional-palettes` (auto-fix): `define-light-theme($p, $a, $w)` and the v18 `m2-define-*` forms, through any namespace, become the config map.
  - `material/button-trailing-icon` (auto-fix): adds `iconPositionEnd` to trailing `<mat-icon>`s in MDC buttons.
  - `deps/perfect-scrollbar-content` (info).
- **v17+**
  - `build/esbuild-external-dependencies` (auto-fix): adds `externalDependencies: ["jsdom"]` when fabric < 6, canvg < 2 or jsdom is installed. It also excludes the libraries the app imports (e.g. fabric) from the dev server's pre-bundling; otherwise `ng serve` fails with `Failed to resolve module specifier "jsdom"`.
  - `build/application-builder-output`: deploy/CI files still copying `dist/<app>` instead of `dist/<app>/browser`.
  - `template/structural-trailing-separator` (auto-fix): `*ngIf="a,"`, which becomes NG5002 after the control-flow migration.
  - `template/invalid-html` (auto-fix for attributes written with no space between them, e.g. `*ngIf="x"style="…"`): templates the control-flow migration rejects. Unbalanced tags are listed with their line.
  - `template/loop-variable-named-in` (auto-fix): renames the variable and tracks by `$index`.
- **v18**
  - `core/duplicate-metadata-entries` (auto-fix): the same entry twice in `imports`/`declarations`/`providers`. The v18 HTTP migration leaves a dangling `HttpClientModule` otherwise.
- **v19+**
  - `template/style-relative-url` (auto-fix, builder-aware): relative `url()` in template `<style>` blocks. Webpack gets `^`. The esbuild application builder gets a path relative to the component, and declarations whose file is missing are removed. Existing `^` URLs are blockers on esbuild.
  - `sass/module-system`: Sass `@import` and global built-ins (`map-get`, `darken`, `blue()`, …), CSS-function-safe.
  - `deps/common-directive-constructors`: library bundles calling the pre-v19 `NgClass`/`NgStyle` constructors (runtime crash).
- **v21**
  - `template/control-flow-auto-migration`: warns that `ng update` rewrites every structural directive.
  - `router/relative-link-above-root` (auto-fix): `../` links above the root throw NG04005 on every change detection.
  - `types/uint8array-buffer-source` (auto-fix): `Uint8Array` into `crypto.subtle` with TypeScript 5.9. It is skipped once TS 5.9 is installed.
- **v12+ (RxJS 7)**
  - `rxjs/subscribe-callbacks` (auto-fix): `subscribe(next, error, complete)` → `subscribe({ next, error, complete })`; single-callback calls are left alone.
- **v22**
  - `rxjs/subject-next-without-value` (auto-fix): `next(undefined)`.
  - `ts/strict-default` (auto-fix): pins `"strict": false` against the TypeScript 6 default.
  - `ts/called-namespace-import` (auto-fix): `import * as X` used as `X()` (TS2349) or `new X()` (esbuild runtime crash).
  - `ts/deprecated-options` (auto-fix): `baseUrl` → narrow `paths` (never `"*"`), and drops `downlevelIteration`.
  - `deps/removed-angular-apis`: library bundles importing exports Angular removed (built-in list before the update, the installed typings after).
  - `deps/library-api-renames` (auto-fix): ngx-material-timepicker → ngx-mat-timepicker, and `ImageCropperModule` → `ImageCropperComponent`.
  - `material/conflicting-button-variants` (auto-fix): NG8023.
  - `build/extended-diagnostics-without-strict-templates` (auto-fix): NG4003.
  - `core/hammer-loader`: `HammerLoader`/`HAMMER_LOADER` were removed.
- **`current`**
  - `template/parse-errors`: parses every template with the project's own `@angular/compiler`.

### Changed rules

- `env/node-version`:
  - lists the supported majors and the first unsupported one, and the nvm-installed versions that fit;
  - suggests the latest release of the newest supported major.
  - The v22 range is `^22.22.3 || ^24.15.0 || >=26.0.0` (v21: `>=24`).
- `env/rxjs-version` and `rxjs/compat-package` are blockers for v22, since RxJS 7 is required.
- `rxjs/deep-imports`:
  - auto-fixes `rxjs/internal/*` public symbols and `rxjs/Rx` named imports;
  - pipes single patch operators;
  - removes `rxjs/add/*` imports nothing uses;
  - recognises `rxjs-compat/*`.
- `rxjs/compat-imports-without-package`: new blocker when RxJS 5 imports have no rxjs-compat behind them.
- `material/legacy-components`: catches `MatLegacy*`/`getMatLegacy*` imported from MDC entry points.
- `material/mdc-style-overrides`: adds `.mat-button` → `.mat-mdc-button` and `.mat-button-wrapper` → `.mdc-button__label`, and flags `overflow-x` on MDC buttons.
- `deps/flex-layout`:
  - blocker from v19 (runtime crash);
  - the auto-fix swaps it for `@ngbracket/ngx-layout@^N` and rewrites imports, including deep entry points.
- `core/component-factory-resolver`:
  - blocker on v22 ("removed");
  - notes files outside the build graph;
  - auto-fixes the `ViewContainerRef` pattern.
- `http/http-client-module`: only real `imports:` entries.
- `ivy/view-engine-libraries`: libraries nothing imports are warnings ("unused; npm uninstall").
- `lint/tslint`: always a warning.

### Engine and CLI

- **Findings**
  - A finding can now have its own severity and its own fixable flag.
  - The `[auto-fix]` tag and the "N auto-fixable" count include only findings that can really be fixed.
- **`fix`**
  - It says "Applied" only when files changed.
  - The "Still needs a human" list shows every remaining finding.
- **`deps`**
  - `--online` treats a release with no `@angular/core` peer, or a wildcard one, as compatible, and never points at an older release.
  - It prefers per-Angular-major releases over open-ended peers.
  - It flags View Engine builds as upgrade/remove.
  - It reads the target CLI's `engines.node` from the registry.
- **`deps` commands**
  - Angular-peer libraries that need a bump go into the same `ng update` command.
  - `--legacy-peer-deps` is visible in every printed command.
  - Every plan ends with "clear `.angular/cache`".
- **`deps --apply`**
  - It checks Node before anything else.
  - When the CLI rejects the Node version, it prints the Node fix instead of `--ng-force`/cache hints.
  - `applyDepCommands` is now async and keeps the failed command's stderr.
- **`current --tsc`** uses the project's own TypeScript and says which one.
- **`plan`** shows the Node range and whether the running Node fits.
- **New `vscode` command.**
- **Package versions:** `--registry` accepts `http://` registries, and `deps` suggests `rxjs@^7.8.0` once a target requires RxJS 7.

## 0.3.0

Initial public release: 41 rules from v6 to v22, dependency advice, `types` and `strict` passes.
