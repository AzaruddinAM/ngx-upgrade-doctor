# ngx-upgrade-doctor

[![npm version](https://img.shields.io/npm/v/ngx-upgrade-doctor.svg)](https://www.npmjs.com/package/ngx-upgrade-doctor)
[![npm downloads](https://img.shields.io/npm/dm/ngx-upgrade-doctor.svg)](https://www.npmjs.com/package/ngx-upgrade-doctor)
[![license](https://img.shields.io/npm/l/ngx-upgrade-doctor.svg)](https://opensource.org/licenses/MIT)
[![node](https://img.shields.io/node/v/ngx-upgrade-doctor.svg)](https://nodejs.org)
[![sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2?logo=githubsponsors)](https://github.com/sponsors/AzaruddinAM)

**Know what will break before you run `ng update` — and clean up what is left after it.**

`ngx-upgrade-doctor` is a command-line tool for upgrading Angular workspaces from **v6 to v22**, one major version at a time. For every hop it reports what will break (with file, line, fix hint and docs link), applies the fixes it can make safely, picks library versions that fit, and runs the update for you. On v22 it adds explicit types, fixes strict-mode errors and gives a finished upgrade a final pass.

```bash
npx ngx-upgrade-doctor plan --target 22     # the whole route, hop by hop
npx ngx-upgrade-doctor scan --target 8      # what blocks the next hop?
npx ngx-upgrade-doctor finalize             # final touch on an Angular 22 workspace
```

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Finalizing an Angular 22 upgrade](#finalizing-an-angular-22-upgrade)
- [Version-by-version guide](#version-by-version-guide)
- [Commands](#commands) and [options](#options)
- [What it checks](#what-it-checks)
- [Fixing misaligned screens after the MDC rewrite](#fixing-misaligned-screens-after-the-mdc-rewrite)
- [Dependency advice](#dependency-advice) and [troubleshooting](#troubleshooting-installs)
- [Explicit types](#explicit-types-v22) and [strict-mode errors](#strict-mode-errors)
- [Use in CI](#use-in-ci) · [Programmatic API](#programmatic-api) · [Adding a rule](#adding-a-rule) · [Rule reference](#rule-reference)
- [Support the project](#support-the-project) · [Professional help](#professional-help)

## Features

Angular does not support skipping majors: an app on 6 goes 6 → 7 → 8 → … → 22. Each hop has its own traps — RxJS deep imports, Ivy, node-sass, TSLint, Material theming, View Engine libraries, the MDC rewrite, control flow, the esbuild builder, TypeScript 6. `ng update` migrates Angular's own code; it does not tell you about the rest.

- **90 rules** across every hop, including runtime-only failures that `ng build` misses (NG04005 router links, flex-layout on v19, removed Angular APIs inside libraries, esbuild namespace-import crashes).
- **Safe auto-fixes** with a `--dry-run` preview. Fixes that only compile on a newer version are deferred until after `ng update`, so the build never breaks in between.
- **Dependency advice** checked against each package's `peerDependencies` on npm, and an `--apply` mode that runs `ng update`, `npm uninstall` and `npm install` in the right order.
- **Types and strict mode for v22**: explicit types, strict-mode fixes and `"possibly 'undefined'"` fixes, each verified by recompiling before a file is written.
- **A final pass** (`finalize`) for an upgraded workspace: compatible libraries, every style/Material/Sass/template/RxJS fix from any earlier version, types, a fresh build cache and a last check.
- **CI-friendly**: `scan` exits with code 1 while blockers remain; `--json` output.
- **Builder-aware**: tells the webpack `browser` and esbuild `application` builders apart (`^` URLs, `externalDependencies`, `dist/<app>/browser`, script flags).

## Requirements

- **Node.js 14.17+** to run the tool. The Angular CLI of each hop has its own Node range (shown by `plan` and checked by `deps --apply`); [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows) makes switching easy.
- An Angular workspace (a `package.json` with `@angular/core`). Run commands from the workspace root, or pass `--project <dir>`.
- **npm** for `deps --apply` and `finalize`. In yarn, pnpm or bun workspaces the tool prints the commands instead of running them.

## Installation

No install is needed: `npx` downloads and runs the latest version.

```bash
npx ngx-upgrade-doctor@latest scan --target 8
```

To pin a version for your team, add it as a dev dependency (`npx` then uses the copy in `node_modules`):

```bash
npm install --save-dev ngx-upgrade-doctor
```

Or install it globally to get the `ngx-upgrade-doctor` command everywhere: `npm install -g ngx-upgrade-doctor`. The examples below use `npx`.

## Quick start

Repeat this loop for every major version until you reach your target:

| Step | Command |
|---|---|
| 1. Scan for blockers | `npx ngx-upgrade-doctor scan --target 8` |
| 2. Apply the safe fixes | `npx ngx-upgrade-doctor fix --target 8` |
| 3. Pick library versions | `npx ngx-upgrade-doctor deps --target 8 --online` |
| 4. Update Angular and libraries | `npx ngx-upgrade-doctor deps --target 8 --online --apply` — or run the printed commands yourself |
| 5. Apply the fixes that waited | `npx ngx-upgrade-doctor current --fix --tsc` |
| 6. Verify and commit | `ng build && ng test --watch=false` |

Commit after each hop, so every version is one reviewable change. The official per-hop checklist is at [angular.dev/update-guide](https://angular.dev/update-guide).

## Finalizing an Angular 22 upgrade

Whether the upgrade went by the book or not — skipped steps, libraries installed by hand, a half-finished `ng update` — `finalize` brings an Angular 22 workspace to a clean state in one run:

```bash
git commit -am "before finalize"                   # every step can be reviewed as one diff
npx ngx-upgrade-doctor finalize --dry-run          # preview: nothing is installed or written
npx ngx-upgrade-doctor finalize                    # asks before installing and before adding types
```

| Step | What it does |
|---|---|
| 1. Dependencies | Reads `package.json` and installs the library versions compatible with the installed Angular (`deps --online --apply`): `ng update` for what is behind, swaps for abandoned libraries, `npm install` for the rest. Removes leftover `angular-cli-tmp-packages-*` folders and stops early on "invalid" installs that would make `ng update` fail. |
| 2. Code, style and config fixes | Every auto-fix that applies to the installed version, from whichever hop it was introduced in: `~` Sass imports, Material theming and MDC class/markup changes (buttons, chips, sliders), old Material class overrides renamed to their MDC classes, removed form-field appearances, the ✓ on single-selection dropdowns hidden, Sass in `.css` files, template `url()`s, structural-directive and HTML errors, RxJS imports, `subscribe(next, error)` → `subscribe({ next, error })` (single callbacks too), builder and tsconfig options. Runs `npm install` if a fix changed `package.json`. |
| 3. Types | Asks which [types mode](#explicit-types-v22) to use. `nullable` adds `: any` only where strict null checks report *"'x' is possibly 'undefined'"* (TS18048); then offers the [strict-mode fixes](#strict-mode-errors). |
| 4. Build cache | Deletes `.angular/cache`, so `ng serve` does not reuse pre-upgrade bundles. |
| 5. What is left | Re-runs the rules, parses every template with your `@angular/compiler`, type-checks with your TypeScript, and lists what needs a human. |

Options: `--yes` (no questions; types use `--mode nullable` unless you pass `--mode`), `--dry-run`, `--skip-deps`, `--skip-types`, `--offline` (built-in version table instead of the npm registry), `--no-tsc`, `--legacy-peer-deps`. It exits with code 1 while blockers remain.

Then run `ng build`, `ng test --watch=false` and `ng serve`, and check each screen — Material 3, zoneless and control-flow migrations are choices, not fixes, and are left to you.

## Version-by-version guide

### Before you start

1. **Commit everything** and create a branch, e.g. `git switch -c upgrade/angular-8`. Every hop should be one reviewable commit.
2. **Print your route:** `ngx-upgrade-doctor plan --target 22`.
3. **Install [nvm-windows](https://github.com/coreybutler/nvm-windows)** (or [nvm](https://github.com/nvm-sh/nvm) on macOS/Linux). The tool itself needs Node 14.17+, but `ng update` and `ng build` need the Node version of the hop — run the tool with a modern Node, then `nvm use` the hop's Node for the Angular commands. On hops below v12 the tool's Node check will therefore always flag the Node it runs on; that is the reminder of which Node to use for `ng`.
4. **Using Angular Material?** Add `@angular/material@N` to every `ng update` below (the tool's `deps` command prints it for you).
5. **Updates are automated:** every hop below uses `ngx-upgrade-doctor deps --target N --online --apply`. It shows the commands, asks `y/N`, then runs `ng update` for Angular/Material, `npm uninstall` for packages to remove, `npm install --save` for `dependencies` and `npm install --save-dev` for `devDependencies` (see [Automatic upgrade](#automatic-upgrade)). Preview with `--apply --dry-run`; skip the question with `--apply --yes`. Prefer to run `ng update` yourself? Use the `# by hand instead` line.
6. **Projects with git dependencies:** prefer `npx` (or a global install) over adding the tool to the project. Installing into such a project makes npm 8 rebuild them, which can fail with `pickAlgorithm` — see [Troubleshooting installs](#troubleshooting-installs).

Each hop below lists the requirements, the commands, what the tool catches, and what you check by hand. `N` = the version you are moving to.

<details>
<summary><b>6 → 7</b> · Node 8.9 / 10.9 · TypeScript 3.1–3.2 · RxJS ^6.3</summary>

```bash
ngx-upgrade-doctor scan --target 7
ngx-upgrade-doctor fix --target 7
ngx-upgrade-doctor deps --target 7 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@7 @angular/cli@7
```

- **Tool catches:** RxJS 5-style deep imports (`rxjs/Observable`, `rxjs/operators/map`, auto-fix), `rxjs-compat` still installed, TypeScript/RxJS/zone.js versions.
- **By hand:** `rxjs/add/operator/*` patch imports → `.pipe()`. Check the new CLI bundle budgets in `angular.json`.
- **Tip:** clean all rxjs imports now — it makes 8, 9 and the later RxJS 7 move painless.

**Dependencies for v7**

| Package | Version | Note |
|---|---|---|
| Node.js | ^8.9.0 or ^10.9.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=3.1.1 <3.3.0` | `ng update` usually bumps it |
| rxjs | `^6.3.0` |  |
| zone.js | `~0.8.26` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^7.0.0` | `ng update @angular/core@7 @angular/cli@7` |
| @angular/material, @angular/cdk | `^7.0.0` | Add `@angular/material@7` to `ng update` |
| @angular-devkit/build-angular | `~0.13.0` | Updated by `ng update` |
| @ngrx/* | `^7.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^4.2.2` |  |
| ngx-bootstrap | `^4.3.0` |  |
| primeng | `^7.1.3` |  |
| ngx-toastr | `^10.2.0` |  |
| @ngx-translate/core | `^11.0.1` |  |
| ng2-charts | `^2.2.3` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 7 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>7 → 8</b> · Node 10.9 / 12 · TypeScript 3.4–3.5 · RxJS ^6.4</summary>

```bash
ngx-upgrade-doctor scan --target 8
ngx-upgrade-doctor fix --target 8
ngx-upgrade-doctor deps --target 8 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@8 @angular/cli@8
ngx-upgrade-doctor current --fix
```

- **Blocker:** `@angular/http` is removed — move to `HttpClient` from `@angular/common/http` first.
- **Tool catches:** string `loadChildren: './x.module#XModule'` (auto-fix to `import()`), `@ViewChild` without `{ static }`, core-js 2 polyfill paths (auto-fix), node-sass (start planning).
- **By hand:** `ng update` adds `{ static: true|false }`; check any it marks with a TODO. Set `"module": "esnext"` in tsconfig for dynamic imports.

**Dependencies for v8**

| Package | Version | Note |
|---|---|---|
| Node.js | ^10.9.0 or ^12.0.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=3.4.0 <3.6.0` | `ng update` usually bumps it |
| rxjs | `^6.4.0` |  |
| zone.js | `~0.9.1` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^8.0.0` | `ng update @angular/core@8 @angular/cli@8` |
| @angular/material, @angular/cdk | `^8.0.0` | Add `@angular/material@8` to `ng update` |
| @angular-devkit/build-angular | `~0.800.0` | Updated by `ng update` |
| @ngrx/* | `^8.0.0` | Released in step with Angular |
| @angular-builders/* | `^8.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^5.3.1` |  |
| ngx-bootstrap | `^5.6.2` |  |
| primeng | `^8.1.1` |  |
| ngx-toastr | `^11.3.3` |  |
| @ngx-translate/core | `^11.0.1` |  |
| ng2-charts | `^2.3.0` |  |
| @angular/http | **remove** | Removed in v8. Migrate to HttpClient (@angular/common/http) first. |
| rxjs-compat | **remove** | Remove once deep rxjs imports are gone; required before RxJS 7. |
| core-js | check | Not needed for evergreen browsers since v8 (differential loading). Keep only for specific polyfills. |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 8 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>8 → 9</b> · Node 10.13 / 12.11 · TypeScript 3.6–3.8 · RxJS ^6.5.3 · <i>Ivy</i></summary>

```bash
ngx-upgrade-doctor scan --target 9
ngx-upgrade-doctor fix --target 9
ngx-upgrade-doctor deps --target 9 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@9 @angular/cli@9
ngx-upgrade-doctor current --fix
```

- **Blocker:** `Renderer` (v1) is removed — use `Renderer2`.
- **Tool catches (applied after the update):** `entryComponents` removal, `TestBed.get` → `TestBed.inject`, `ModuleWithProviders` without a type.
- **By hand:** if you use i18n, run `ng add @angular/localize`. If Ivy breaks a library, `"enableIvy": false` is a temporary escape only — the tool flags it until v13.

**Dependencies for v9**

| Package | Version | Note |
|---|---|---|
| Node.js | ^10.13.0 or ^12.11.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=3.6.4 <3.9.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3` |  |
| zone.js | `~0.10.2` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^9.0.0` | `ng update @angular/core@9 @angular/cli@9` |
| @angular/material, @angular/cdk | `^9.0.0` | Add `@angular/material@9` to `ng update` |
| @angular-devkit/build-angular | `~0.900.0` | Updated by `ng update` |
| @ngrx/* | `^9.0.0` | Released in step with Angular |
| @angular-builders/* | `^9.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^6.2.0` |  |
| ngx-bootstrap | `^6.2.0` |  |
| primeng | `^9.1.3` |  |
| ngx-toastr | `^12.1.0` |  |
| @ngx-translate/core | `^12.1.2` |  |
| ng2-charts | `^2.4.2` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 9 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>9 → 10</b> · Node 10.13 / 12.11 · TypeScript 3.9–4.0 · RxJS ^6.5.3</summary>

```bash
ngx-upgrade-doctor scan --target 10
ngx-upgrade-doctor fix --target 10
ngx-upgrade-doctor deps --target 10 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@10 @angular/cli@10
```

- **Blocker:** `ModuleWithProviders` needs its type argument (auto-fix: `ModuleWithProviders<SharedModule>`). Third-party modules without it need a library upgrade — run `deps --target 10 --online`.
- **By hand:** review CommonJS dependency warnings in the build output.

**Dependencies for v10**

| Package | Version | Note |
|---|---|---|
| Node.js | ^10.13.0 or ^12.11.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=3.9.0 <4.1.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3` |  |
| zone.js | `~0.10.3` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^10.0.0` | `ng update @angular/core@10 @angular/cli@10` |
| @angular/material, @angular/cdk | `^10.0.0` | Add `@angular/material@10` to `ng update` |
| @angular-devkit/build-angular | `~0.1000.0` | Updated by `ng update` |
| @ngrx/* | `^10.0.0` | Released in step with Angular |
| @angular-builders/* | `^10.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^7.0.0` |  |
| ngx-bootstrap | `^6.2.0` |  |
| primeng | `^10.0.3` |  |
| ngx-toastr | `^13.2.1` |  |
| @ngx-translate/core | `^13.0.0` |  |
| ng2-charts | `^2.4.2` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 10 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>10 → 11</b> · Node 10.13 / 12.11 · TypeScript 4.0–4.1 · RxJS ^6.5.3</summary>

```bash
ngx-upgrade-doctor scan --target 11
ngx-upgrade-doctor deps --target 11 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@11 @angular/cli@11
ngx-upgrade-doctor current --fix
```

- **Tool catches:** `async()` test wrapper → `waitForAsync()` (auto-fix, leaves the `async` keyword alone), TSLint deprecation, node-sass warning.
- **Tip:** do the ESLint and sass moves now, before they become blockers in 12–13.

**Dependencies for v11**

| Package | Version | Note |
|---|---|---|
| Node.js | ^10.13.0 or ^12.11.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=4.0.0 <4.2.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3` |  |
| zone.js | `~0.11.3` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^11.0.0` | `ng update @angular/core@11 @angular/cli@11` |
| @angular/material, @angular/cdk | `^11.0.0` | Add `@angular/material@11` to `ng update` |
| @angular-devkit/build-angular | `~0.1100.0` | Updated by `ng update` |
| @ngrx/* | `^11.0.0` | Released in step with Angular |
| @angular-builders/* | `^11.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^9.1.3` |  |
| ngx-bootstrap | `^6.2.0` |  |
| primeng | `^11.4.5` |  |
| ngx-toastr | `^13.2.1` |  |
| @ngx-translate/core | `^13.0.0` |  |
| ng2-charts | `^2.4.3` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 11 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>11 → 12</b> · Node 12.14 / 14.15 · TypeScript 4.2–4.3 · RxJS ^6.5.3 or ^7</summary>

```bash
ngx-upgrade-doctor scan --target 12
ngx-upgrade-doctor fix --target 12
ngx-upgrade-doctor deps --target 12 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@12 @angular/cli@12 @angular/material@12
ngx-upgrade-doctor current --fix
```

- **Blocker:** node-sass is unsupported (auto-fix to `sass`).
- **Tool catches:** Material global Sass API → `@use '@angular/material' as mat` (auto-fix: `mat.core()`, `mat.define-palette(mat.$indigo-palette)`, `mat.define-light-theme()`, `mat.all-component-themes()`), `zone.js/dist/*` imports (auto-fix), Protractor end-of-life, TSLint.
- **By hand:** `ng add @angular-eslint/schematics`, then `ng g @angular-eslint/schematics:convert-tslint-to-eslint`. `ng build` now defaults to production — check your scripts.

**Dependencies for v12**

| Package | Version | Note |
|---|---|---|
| Node.js | ^12.14.0 or ^14.15.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=4.2.3 <4.4.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.0.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.11.4` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^12.0.0` | `ng update @angular/core@12 @angular/cli@12` |
| @angular/material, @angular/cdk | `^12.0.0` | Add `@angular/material@12` to `ng update` |
| @angular-devkit/build-angular | `^12.0.0` | Updated by `ng update` |
| @ngrx/* | `^12.0.0` | Released in step with Angular |
| @angular-eslint/* | `^12.0.0` | Released in step with Angular |
| @angular-builders/* | `^12.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^10.0.0` |  |
| ngx-bootstrap | `^7.1.2` |  |
| primeng | `^12.2.3` |  |
| ngx-toastr | `^14.3.0` |  |
| @ngx-translate/core | `^13.0.0` |  |
| ng2-charts | `^3.0.11` |  |
| node-sass | **replace** → sass@^1.32.0 | node-sass is unsupported from v12. Replace with sass (Dart Sass). |
| tslint, codelyzer | **replace** → @angular-eslint/schematics | TSLint is deprecated. Run `ng add @angular-eslint/schematics` and convert. |
| protractor | **replace** → cypress or playwright | Protractor is end-of-life. |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 12 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>12 → 13</b> · Node 12.20 / 14.15 / 16.10 · TypeScript 4.4–4.5 · RxJS ^6.5.3 or ^7.4 · <i>View Engine removed</i></summary>

```bash
ngx-upgrade-doctor scan --target 13
ngx-upgrade-doctor deps --target 13 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@13 @angular/cli@13
ngx-upgrade-doctor current --fix
```

- **Blockers:** string `loadChildren`, `"enableIvy": false`, the TSLint builder.
- **Tool catches:** libraries still shipping View Engine metadata (run `npm install` first so it can inspect `node_modules`), `~` in Sass imports (auto-fix), IE11 in browserslist (auto-fix), `ComponentFactoryResolver`.
- **By hand:** add `.angular/cache` to `.gitignore`. Replace any library with no Ivy release — it stops working entirely in v16.

**Dependencies for v13**

| Package | Version | Note |
|---|---|---|
| Node.js | ^12.20.0 or ^14.15.0 or ^16.10.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=4.4.2 <4.6.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.11.4` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^13.0.0` | `ng update @angular/core@13 @angular/cli@13` |
| @angular/material, @angular/cdk | `^13.0.0` | Add `@angular/material@13` to `ng update` |
| @angular-devkit/build-angular | `^13.0.0` | Updated by `ng update` |
| @ngrx/* | `^13.0.0` | Released in step with Angular |
| @angular-eslint/* | `^13.0.0` | Released in step with Angular |
| @angular-builders/* | `^13.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^11.0.1` |  |
| ngx-bootstrap | `^8.0.0` |  |
| primeng | `^13.4.1` |  |
| ngx-toastr | `^14.3.0` |  |
| @ngx-translate/core | `^14.0.0` |  |
| ng2-charts | `^3.0.11` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 13 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>13 → 14</b> · Node 14.15 / 16.10 · TypeScript 4.6–4.8 · RxJS ^6.5.3 or ^7.4</summary>

```bash
ngx-upgrade-doctor scan --target 14
ngx-upgrade-doctor deps --target 14 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@14 @angular/cli@14
ngx-upgrade-doctor current --fix
```

- **Tool catches:** `defaultProject` in `angular.json` (auto-fix), `UntypedFormGroup`/`UntypedFormControl` left by the update.
- **By hand:** move forms back to typed `FormGroup`/`FormControl` one form at a time.

**Dependencies for v14**

| Package | Version | Note |
|---|---|---|
| Node.js | ^14.15.0 or ^16.10.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=4.6.2 <4.9.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.11.4` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^14.0.0` | `ng update @angular/core@14 @angular/cli@14` |
| @angular/material, @angular/cdk | `^14.0.0` | Add `@angular/material@14` to `ng update` |
| @angular-devkit/build-angular | `^14.0.0` | Updated by `ng update` |
| @ngrx/* | `^14.0.0` | Released in step with Angular |
| @angular-eslint/* | `^14.0.0` | Released in step with Angular |
| @angular-builders/* | `^14.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^13.1.1` |  |
| ngx-bootstrap | `^9.0.0` |  |
| primeng | `^14.2.3` |  |
| ngx-toastr | `^15.2.2` |  |
| @ngx-translate/core | `^14.0.0` |  |
| ng2-charts | `^4.1.1` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 14 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>14 → 15</b> · Node 14.20 / 16.13 / 18.10 · TypeScript 4.8–4.9 · <i>Material MDC</i></summary>

```bash
ngx-upgrade-doctor scan --target 15
ngx-upgrade-doctor deps --target 15 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@15 @angular/cli@15 @angular/material@15
```

- **Blockers:** `zone.js/dist` imports, Protractor.
- **Tool catches:** `@angular/flex-layout` (deprecated, no new releases), style overrides on old Material classes such as `.mat-form-field-infix` that will stop matching, class-based guards, NgModule components that could be standalone.
- **By hand:** `ng update` switches Material to `legacy-*` imports so the app keeps working. Plan the MDC migration now: `ng generate @angular/material:mdc-migration`, then re-check every screen's spacing.

**Dependencies for v15**

| Package | Version | Note |
|---|---|---|
| Node.js | ^14.20.0 or ^16.13.0 or ^18.10.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=4.8.2 <5.0.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.11.4 or ~0.12.0` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^15.0.0` | `ng update @angular/core@15 @angular/cli@15` |
| @angular/material, @angular/cdk | `^15.0.0` | Add `@angular/material@15` to `ng update` |
| @angular-devkit/build-angular | `^15.0.0` | Updated by `ng update` |
| @ngrx/* | `^15.0.0` | Released in step with Angular |
| @angular-eslint/* | `^15.0.0` | Released in step with Angular |
| @angular-builders/* | `^15.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^14.2.0` |  |
| ngx-bootstrap | `^10.3.0` |  |
| primeng | `^15.4.1` |  |
| ngx-toastr | `^16.2.0` |  |
| @ngx-translate/core | `^14.0.0` |  |
| ng2-charts | `^4.1.1` |  |
| @angular/flex-layout | **replace** → `@ngbracket/ngx-layout@^15` (drop-in fork, majors track Angular); long term CSS flex/grid + @angular/cdk/layout | Deprecated, no releases past 15; crashes at runtime from v19. |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 15 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>15 → 16</b> · Node 16.14 / 18.10 · TypeScript 4.9–5.1 · <i>ngcc removed</i></summary>

```bash
ngx-upgrade-doctor scan --target 16
ngx-upgrade-doctor deps --target 16 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@16 @angular/cli@16 @angular/material@16
```

- **Blockers:** `ngcc` in `postinstall` (auto-fix), any library still built for View Engine (a View Engine library nothing imports is only a warning: uninstall it).
- **Tool catches:**
  - imports of packages missing from package.json (commented-out imports are ignored; e2e/spec files are warnings);
  - RxJS 5 patch imports without `rxjs-compat`;
  - `src/polyfills.ts` `core-js/es*` imports (auto-fix removes them);
  - leftover `MatLegacy*`/`getMatLegacy*` symbols imported from MDC entry points (auto-fix renames them);
  - positional palettes in `define-light-theme`;
  - libraries known to break here: `ngx-perfect-scrollbar` → the drop-in fork `ngx-om-perfect-scrollbar@^16` (`fix` swaps it and rewrites imports), `ngx-material-timepicker` < 13, `ngx-webcam` < 0.4, `ngx-image-cropper` 2, `ng2-pdf-viewer` 6 (install the `pdfjs-dist` its peers name), `angular-calendar` < 0.31;
  - `NgxMaterialTimepickerModule.forRoot()`, gone in timepicker 13 (`fix` imports the module itself);
  - the pre-MDC `mat-slider` API (`fix`: `thumbLabel` → `discrete`, `tickInterval` → `showTickMarks`, `[(ngModel)]`/`(change)` onto `<input matSliderThumb>`);
  - `webpack` missing after `npm install --legacy-peer-deps` (it's a peer of `@angular-devkit/build-angular`, so legacy mode skips it: `npm i -D webpack@<range>`).
- **By hand:** finish the Material MDC migration on this version — legacy components are gone in 17. After MDC, check buttons: a trailing `<mat-icon>` now renders before the label (rule `material/button-trailing-icon` adds `iconPositionEnd`), and `.mat-button`/`.mat-button-wrapper` overrides no longer match (`.mat-mdc-button`/`.mdc-button__label`).

**Dependencies for v16**

| Package | Version | Note |
|---|---|---|
| Node.js | ^16.14.0 or ^18.10.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=4.9.3 <5.2.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.13.0` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^16.0.0` | `ng update @angular/core@16 @angular/cli@16` |
| @angular/material, @angular/cdk | `^16.0.0` | Add `@angular/material@16` to `ng update` |
| @angular-devkit/build-angular | `^16.0.0` | Updated by `ng update` |
| @ngrx/* | `^16.0.0` | Released in step with Angular |
| @angular-eslint/* | `^16.0.0` | Released in step with Angular |
| @angular-builders/* | `^16.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^15.1.2` |  |
| ngx-bootstrap | `^11.0.2` |  |
| primeng | `^16.9.1` |  |
| ngx-toastr | `^17.0.2` |  |
| @ngx-translate/core | `^15.0.0` |  |
| ng2-charts | `^5.0.4` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 16 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>16 → 17</b> · Node 18.13 / 20.9 · TypeScript 5.2–5.4 · <i>control flow, esbuild</i></summary>

```bash
ngx-upgrade-doctor scan --target 17
ngx-upgrade-doctor fix --target 17
ngx-upgrade-doctor deps --target 17 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@17 @angular/cli@17 @angular/material@17
ngx-upgrade-doctor current --fix
```

- **Blocker:** legacy Material imports (auto-fix: `MatLegacyButtonModule` → `MatButtonModule`, `@angular/material/legacy-button` → `@angular/material/button`, `mat.legacy-*` Sass).
- **Tool catches:** `@nguniversal/*` (moves to `@angular/ssr`), `*ngIf`/`*ngFor`, the webpack `browser` builder.
- **Optional, recommended:** `ng generate @angular/core:control-flow` and `ng update @angular/cli --name use-application-builder` (faster builds; fix `~` imports and custom webpack config first).
- **After switching to the esbuild `application` builder** (the tool checks all of these):
  - the output moves to `dist/<app>/browser`: point deploy scripts, Dockerfiles and CI at it;
  - `url('^…')` no longer resolves: `fix` rewrites it relative to the component;
  - `fabric@<6` / `canvg@<2` bundle `jsdom`, giving ~100 "Could not resolve 'util'…" errors: `fix` adds `"externalDependencies": ["jsdom"]`;
  - `--build-optimizer`, `--vendor-chunk`, `--common-chunk` and `--deploy-url` in package.json scripts are rejected: `fix` removes them;
  - `new X()` on `import * as X` builds with a warning and crashes in production: `fix` makes it a default import;
  - file names in the wrong letter case become `[different-path-case]`.
- **Runtime:** `@angular/flex-layout` keeps working until v19, but move off it now (see 18 → 19).
- **Lessons from the real 16 → 17 run:**
  - **Library order:** run `deps --target 17 --online --apply`, not a bare `ng update`. Third-party libraries whose old peer range says `@angular/core ^15` (e.g. `angular-in-memory-web-api`) make `ng update` fail with "Incompatible peer dependencies"; `deps` puts their upgrades in the same `ng update` command.
  - **No Angular peer:** a library release with no `@angular/core` peer (ng2-pdf-viewer 10, ngx-webcam 0.4, ngx-material-timepicker 13) is fine. It is not "check / use an older version".
  - **View Engine:** a View Engine library you don't import anywhere just needs `npm uninstall`.
  - **`--tsc`** type-checks with the project's own TypeScript; the bundled compiler's newer lib typings gave fake `Uint8Array` TS2322 errors.
  - **Flags:** `--legacy-peer-deps` / `--force` / `--allow-dirty` now appear in every printed command.
  - **Node:** v17 accepts Node 20.9, but current sass releases need 20.19+, so install the latest 20.x (`nvm install 20`).
  - **TSLint** is a warning, not a blocker: it never breaks `ng build`.

**Dependencies for v17**

| Package | Version | Note |
|---|---|---|
| Node.js | ^18.13.0 or ^20.9.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=5.2.0 <5.5.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.14.0` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^17.0.0` | `ng update @angular/core@17 @angular/cli@17` |
| @angular/material, @angular/cdk | `^17.0.0` | Add `@angular/material@17` to `ng update` |
| @angular-devkit/build-angular | `^17.0.0` | Updated by `ng update` |
| @ngrx/* | `^17.0.0` | Released in step with Angular |
| @angular-eslint/* | `^17.0.0` | Released in step with Angular |
| @angular-builders/* | `^17.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^16.0.0` |  |
| ngx-bootstrap | `^12.0.0` |  |
| primeng | `^17.18.0` |  |
| ngx-toastr | `^18.0.0` |  |
| @ngx-translate/core | `^15.0.0` |  |
| ng2-charts | `^6.0.1` |  |
| @nguniversal/ | **replace** → @angular/ssr | `ng update` to 17 migrates it to @angular/ssr. |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 17 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>17 → 18</b> · Node 18.19 / 20.11 / 22 · TypeScript 5.4–5.5</summary>

```bash
ngx-upgrade-doctor scan --target 18
ngx-upgrade-doctor deps --target 18 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@18 @angular/cli@18
```

- **Tool catches:** `HttpClientModule` (only real `imports:` entries) — replace with `provideHttpClient(withInterceptorsFromDi())`; in tests `provideHttpClientTesting()`. Before `ng update`, run `fix --target 18`: when an NgModule lists `HttpClientModule` twice, the v18 migration removes the import and only one entry, leaving `TS2304` (rule `core/duplicate-metadata-entries` removes duplicates). Also: the theme rule now matches `mat.m2-define-light-theme($p, $a, $w)` and rewrites it to the config map.

**Dependencies for v18**

| Package | Version | Note |
|---|---|---|
| Node.js | ^18.19.1 or ^20.11.1 or ^22.0.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=5.4.0 <5.6.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.14.0` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^18.0.0` | `ng update @angular/core@18 @angular/cli@18` |
| @angular/material, @angular/cdk | `^18.0.0` | Add `@angular/material@18` to `ng update` |
| @angular-devkit/build-angular | `^18.0.0` | Updated by `ng update` |
| @ngrx/* | `^18.0.0` | Released in step with Angular |
| @angular-eslint/* | `^18.0.0` | Released in step with Angular |
| @angular-builders/* | `^18.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^17.0.1` |  |
| ngx-bootstrap | `^18.1.3` |  |
| primeng | `^17.18.0` |  |
| ngx-toastr | `^19.0.0` |  |
| @ngx-translate/core | `^15.0.0` |  |
| ng2-charts | `^6.0.1` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 18 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>18 → 19</b> · Node 18.19 / 20.11 / 22 · TypeScript 5.5–5.8</summary>

```bash
ngx-upgrade-doctor scan --target 19
ngx-upgrade-doctor deps --target 19 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@19 @angular/cli@19
```

- **Blockers the tool catches:**
  - **`url()` in template `<style>` blocks.** Relative URLs are now resolved at build time (`Can't resolve 'assets/…'`). The fix is `^assets/…` on webpack, or a path relative to the component on esbuild. Declarations whose file doesn't exist are dropped, since they were 404s already.
  - **`@angular/flex-layout` crashes at run time** with `this._renderer.addClass is not a function` (it calls the old `NgClass`/`NgStyle` constructors). The fix swaps it for the drop-in fork `@ngbracket/ngx-layout@^19` and rewrites its imports, including `/flex`, `/extended`, `/core` and `/grid`. `deps` prints the uninstall/install commands.
  - **Other libraries calling those old constructors** are found by reading `node_modules` (`deps/common-directive-constructors`).
- **Warnings:** Sass `@import` and global built-ins (`map-get`, `darken`, `blue()`, …) are deprecated; migrate with `npx sass-migrator module --migrate-deps src/styles.scss`.
- **Node:** `plan` prints each hop's full Node range with "your Node X fits / does not fit". 18.19, 20.11 and 22 all work here; 22 is not required.
- **By hand:** components are standalone by default now; `ng update` adds `standalone: false` to the ones still declared in an NgModule. Migrate with `ng generate @angular/core:standalone` when ready.
- **After any dependency swap:** clear `.angular/cache` before `ng serve`. A stale cache keeps compiler-generated imports of removed packages ("Module not found").

**Dependencies for v19**

| Package | Version | Note |
|---|---|---|
| Node.js | ^18.19.1 or ^20.11.1 or ^22.0.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=5.5.0 <5.9.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.15.0` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^19.0.0` | `ng update @angular/core@19 @angular/cli@19` |
| @angular/material, @angular/cdk | `^19.0.0` | Add `@angular/material@19` to `ng update` |
| @angular-devkit/build-angular | `^19.0.0` | Updated by `ng update` |
| @ngrx/* | `^19.0.0` | Released in step with Angular |
| @angular-eslint/* | `^19.0.0` | Released in step with Angular |
| @angular-builders/* | `^19.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^18.0.0` |  |
| ngx-bootstrap | `^19.0.2` |  |
| primeng | `^19.1.0` |  |
| ngx-toastr | `^19.0.0` |  |
| @ngx-translate/core | `^16.0.0` |  |
| ng2-charts | `^8.0.0` |  |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 19 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>19 → 20</b> · Node 20.19 / 22.12 / 24 · TypeScript 5.8</summary>

```bash
ngx-upgrade-doctor scan --target 20
ngx-upgrade-doctor deps --target 20 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@20 @angular/cli@20
```

- **Tool catches:** `*ngIf`/`*ngFor`/`*ngSwitch` are deprecated (warning from this version) — run `ng generate @angular/core:control-flow`. `@angular/animations` usage (deprecated in 20.2).
- **By hand:** Node 18 is no longer supported. Use the latest 20.x (≥ 20.19) or 22.12+: `nvm install 20`. Current sass releases need 20.19+, so 20.9 is not enough.
- **Sass:** v20's sass also prints `blue() is deprecated. Suggestion: color.channel($color, "blue", $space: rgb)` and the same for the other color channel functions (`red`, `green`, `hue`, `lightness`, `alpha`, …). `sass/module-system` counts them, but not CSS functions with the same names (`filter: opacity(50%)`, `alpha(opacity=50)`, `rgb()`/`hsl()`). Not a blocker.
- **Dependencies:** libraries that ship one release per Angular major but declare open-ended peers (`@ngbracket/ngx-layout`, `@zxing/ngx-scanner`, `ngx-device-detector`, `angular-in-memory-web-api`, …) are moved to the release made for this major by `deps --online`. These upgrades go into the same `ng update` command, so old peer ranges cannot block it.

**Dependencies for v20**

| Package | Version | Note |
|---|---|---|
| Node.js | ^20.19.0 or ^22.12.0 or ^24.0.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=5.8.0 <5.9.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.15.0` |  |
| @angular/* (core, common, forms, router, …), @angular/cli | `^20.0.0` | `ng update @angular/core@20 @angular/cli@20` |
| @angular/material, @angular/cdk | `^20.0.0` | Add `@angular/material@20` to `ng update` |
| @angular-devkit/build-angular | `^20.0.0` | Updated by `ng update` |
| @ngrx/* | `^20.0.0` | Released in step with Angular |
| @angular-eslint/* | `^20.0.0` | Released in step with Angular |
| @angular-builders/* | `^20.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | `^19.0.1` |  |
| ngx-bootstrap | `^20.0.0` |  |
| primeng | `^20.0.0` |  |
| ngx-toastr | — | Not in the built-in table: `deps --online` |
| @ngx-translate/core | `^16.0.0` |  |
| ng2-charts | — | Not in the built-in table: `deps --online` |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 20 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>20 → 21</b> · Node 20.19 / 22.12 / 24 · TypeScript 5.9</summary>

```bash
ngx-upgrade-doctor scan --target 21
ngx-upgrade-doctor deps --target 21 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@21 @angular/cli@21
```

- **`ng update` rewrites every `*ngIf`/`*ngFor`/`*ngSwitch` to `@if`/`@for`/`@switch` automatically.** It is not optional and can take many minutes on a big app. Commit first, then review the diff. Run `fix --target 21` before it:
  - a trailing `,`/`;` in a structural directive (`*ngIf="a && b,"`) becomes `@if (a && b,)`, which fails with NG5002. The fix strips it.
  - a directive written against another attribute (`*ngIf="x"style="…"`) makes the migration skip the template as "invalid HTML". The fix inserts the space. Unbalanced tags are listed with their line.
  - a loop variable named `in` breaks in v22. The fix renames it and tracks by `$index`.
- **Runtime:** `routerLink="../x"` that climbs above the root used to be clamped to `/`; v21 throws `NG04005: Invalid number of '../'` on every change detection. The fix makes links in layout/menu components absolute, and other links are listed to check. Links bound from data (`[routerLink]="menu.url"`) can't be checked: check server-provided menu URLs.
- **TypeScript 5.9:** `Uint8Array` values passed to `crypto.subtle` no longer fit `BufferSource` (TS2322). The fix types them `Uint8Array<ArrayBuffer>`; the rule is skipped once TS 5.9 is installed and `current --tsc` is exact.
- **Tool also catches:** `@angular/animations` (now a warning), and suggests zoneless change detection and Vitest — both are defaults for new apps only; existing apps keep zone.js and Karma until you choose to move.

**Dependencies for v21**

| Package | Version | Note |
|---|---|---|
| Node.js | ^20.19.0 or ^22.12.0 or >=24.0.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=5.9.0 <6.0.0` | `ng update` usually bumps it |
| rxjs | `^6.5.3 or ^7.4.0` | RxJS 7 needs rxjs-compat gone first |
| zone.js | `~0.15.0` | Optional if you go zoneless |
| @angular/* (core, common, forms, router, …), @angular/cli | `^21.0.0` | `ng update @angular/core@21 @angular/cli@21` |
| @angular/material, @angular/cdk | `^21.0.0` | Add `@angular/material@21` to `ng update` |
| @angular-devkit/build-angular | `^21.0.0` | Updated by `ng update` |
| @ngrx/* | `^21.0.0` | Released in step with Angular |
| @angular-eslint/* | `^21.0.0` | Released in step with Angular |
| @angular-builders/* | `^21.0.0` | Released in step with Angular |
| @ng-bootstrap/ng-bootstrap | — | Not in the built-in table: `deps --online` |
| ngx-bootstrap | — | Not in the built-in table: `deps --online` |
| primeng | — | Not in the built-in table: `deps --online` |
| ngx-toastr | — | Not in the built-in table: `deps --online` |
| @ngx-translate/core | — | Not in the built-in table: `deps --online` |
| ng2-charts | — | Not in the built-in table: `deps --online` |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 21 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>21 → 22</b> · Node 22.22.3 / 24.15 / 26 · TypeScript 6.0 · RxJS 7</summary>

```bash
ngx-upgrade-doctor scan --target 22
ngx-upgrade-doctor deps --target 22 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@22 @angular/cli@22
ngx-upgrade-doctor types --dry-run
ngx-upgrade-doctor types
ngx-upgrade-doctor strict          # strict-mode errors left after the types pass
ngx-upgrade-doctor finalize        # or all of the above, plus every style fix and a final check
```

- **Node:** the v22 CLI requires `^22.22.3 || ^24.15.0 || >=26.0.0` and exits at once on anything else ("requires a minimum Node.js version"). `deps --apply` checks this before doing anything; with `--online` the range is read from `@angular/cli`'s `engines.node`.
- **RxJS 7 is required** (blocker), and so is removing `rxjs-compat`. `fix` handles the simple RxJS 5 leftovers:
  - pipes single patch operators (`x.valueChanges.debounceTime(500).subscribe(` → `.pipe(debounceTime(500))`);
  - deletes `rxjs/add/*` and `rxjs/Rx` imports nothing uses (`.toPromise()` still exists);
  - turns `subject.next()` on a non-void `Subject` into `next(undefined)` (TS2554 with RxJS 7).

  `deps` then suggests `rxjs@^7.8.0`.
- **Deprecated `subscribe` callbacks:** with RxJS 7, `subscribe(data => …, err => …)` (several callbacks) is deprecated, and VS Code strikes it through. `fix` rewrites it to `subscribe({ next: data => …, error: err => … })`, inner calls first. A single callback, `subscribe(data => …)`, is still fine and left alone. Types are unchanged, so the rewrite adds no compiler errors.
  - To put **every** subscription in observer style, run the opt-in rule `rxjs/subscribe-observer-style`:
    ```bash
    ngx-upgrade-doctor current --fix --only rxjs/subscribe-observer-style
    ```
    It also converts `subscribe(data => …)` to `subscribe({ next: data => … })`. Only inline callbacks are touched; `subscribe(observer)` and `subscribe(subject)` stay as they are. `finalize` applies it automatically.
- **TypeScript 6** (installed by `ng update`):
  - `strict` defaults to true, which can turn a clean build into thousands of errors. `fix` writes `"strict": false` unless you already set it.
  - `esModuleInterop` is always on, so `import * as moment` + `moment()` fails with TS2349. `fix` turns it into a default import.
  - `baseUrl` and `downlevelIteration` are deprecated (TS5101). `fix` drops `downlevelIteration` for ES2015+ targets. It replaces `baseUrl` with narrow `paths` for the folders bare imports really use (e.g. `"app/*"`), **never** `"*"`: with the CLI's paths plugin, `"*"` re-resolves every package and bundles Node built-ins.
- **Removed APIs:** `ComponentFactoryResolver` and `HammerLoader`/`HAMMER_LOADER` are gone.
  - In your code these are blockers, noted when the file is outside the build graph. `fix` rewrites `vcr.createComponent(resolver.resolveComponentFactory(C))`.
  - In libraries, the tool scans `node_modules` bundles for imports of removed exports. It suggests `@swimlane/ngx-charts@^25.0.3`, `angular-calendar@^0.32.2` (install its peers `angular-draggable-droppable@^9` and `angular-resizable-element@^8` too) and `ngx-image-cropper@^9.1.7` (`ImageCropperModule` → `ImageCropperComponent`). It replaces `ngx-material-timepicker` with `ngx-mat-timepicker@^22`, with the module, element and `[ngxTimepicker]` renames done by `fix`.
- **Templates:**
  - a loop variable named `in` is rejected ("Unexpected token in");
  - a `<button>` with both `mat-raised-button` and `mat-mini-fab` fails with NG8023. `fix` keeps the fab/icon variant.
- **Design (visual) checks:** everything MDC-related from v15 still applies and is checked on v22:
  - theme maps (`m2-define-*`), `.mat-button`/`.mat-form-field-*` overrides;
  - trailing button icons, `overflow-x` on buttons;
  - `mat-slider` → `<input matSliderThumb>`, `<mat-chip-list>` → `<mat-chip-set>`;
  - double button variants (NG8023), perfect-scrollbar containers.

  Not checked, because it is a choice rather than a breakage: moving from the M2 theme API (`mat.m2-*`, still supported on v22) to Material 3 (`mat.theme`). M3 changes colors, density and typography, and makes `color="primary|accent|warn"` attributes do nothing. Review every screen if you switch.
- **Config:** v22 migrations can add `extendedDiagnostics` together with `strictTemplates: false`, which gives NG4003. `fix` removes the `extendedDiagnostics` block.
- **Libraries:** `date-fns` < 2.30 imports `@babel/runtime` helpers that `@babel/runtime` 8 no longer exports. Use `date-fns@^2.30.0`. `jspdf` 1 → 2 is reported as **check** with the removed APIs your code uses (`setFontStyle`, `fromHTML`, …), never as an automatic upgrade.
- **After the update:** `types` offers explicit types (see [Explicit types](#explicit-types-v22)), then `strict` fixes the strict-mode errors that remain (see [Strict-mode errors](#strict-mode-errors)). Do each as a separate commit — or run [`finalize`](#finalizing-an-angular-22-upgrade), which does all of it.

**Dependencies for v22**

| Package | Version | Note |
|---|---|---|
| Node.js | ^22.22.3 or ^24.15.0 or >=26.0.0 | The v22 CLI refuses anything else; `nvm install 24` |
| typescript | `>=5.9.0 <6.1.0` | `ng update` installs 6.0: strict on by default, esModuleInterop always, baseUrl deprecated |
| rxjs | `^7.8.0` | Blocker: Angular 22 peers exclude RxJS 6; remove rxjs-compat |
| zone.js | `~0.15.0` | Optional if you go zoneless |
| @angular/* (core, common, forms, router, …), @angular/cli | `^22.0.0` | `ng update @angular/core@22 @angular/cli@22` |
| @angular/material, @angular/cdk | `^22.0.0` | Add `@angular/material@22` to `ng update` |
| @angular-devkit/build-angular | `^22.0.0` | Updated by `ng update` |
| @ngrx/* | `^22.0.0` | Released in step with Angular — check it is out |
| @angular-eslint/* | `^22.0.0` | Released in step with Angular — check it is out |
| @angular-builders/* | `^22.0.0` | Released in step with Angular — check it is out |
| @ng-bootstrap/ng-bootstrap | — | Not in the built-in table: `deps --online` |
| ngx-bootstrap | — | Not in the built-in table: `deps --online` |
| primeng | — | Not in the built-in table: `deps --online` |
| ngx-toastr | — | Not in the built-in table: `deps --online` |
| @ngx-translate/core | — | Not in the built-in table: `deps --online` |
| ng2-charts | — | Not in the built-in table: `deps --online` |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 22 --online`, which reads each package's `peerDependencies` on npm.

</details>

### After the upgrade: esbuild application builder, production build, runtime

Once you are on v17+ and switch to the `application` builder (`ng update @angular/cli --name use-application-builder`, which `ng new` uses by default), run `ngx-upgrade-doctor current --fix`. Then go through this list. Each item is a rule:

| Symptom | Rule | Fix |
|---|---|---|
| `Could not resolve "^assets/img/x.png" [plugin angular-css-resource]` | `template/style-relative-url` | `^` is webpack-only. The URL becomes a path relative to the component; declarations whose file doesn't exist are removed (they were 404s). |
| ~100 `Could not resolve "util"/"crypto"/"fs"` from fabric/jspdf/canvg/html2pdf.js | `build/esbuild-external-dependencies` | `"externalDependencies": ["jsdom"]` (plus `canvas` when installed). |
| `ng serve` only: `Uncaught TypeError: Failed to resolve module specifier "jsdom"` | `build/esbuild-external-dependencies` | The dev server pre-bundles fabric and turns the external `require('jsdom')` into a top-level `import "jsdom"`. Add `"prebundle": { "exclude": ["fabric"] }` to the serve options (the fix does it), then restart `ng serve`. `ng build` is unaffected. |
| esbuild: "Constructing … will crash at run-time because it's an import namespace object" | `ts/called-namespace-import` | `import * as X` + `new X()` → `import X from …`. A blocker: the build passes, production crashes. |
| `jspdf-autotable` asks for jspdf ^2 | `deps/jspdf-2-breaking-api` | Reported as **check**, with the jspdf 1 APIs your code uses, because upgrading blindly breaks them. |
| `[different-path-case]` warnings; Linux CI can't find `user-popup.html` referenced as `userPopup.html` | `build/file-name-case` | References are rewritten to the on-disk casing. |
| `Unknown argument: build-optimizer`; `--configuration` ignored; flags lost after `npm run x` | `build/package-scripts` | Webpack-only flags removed, `--` inserted, duplicate `--configuration` flagged. |
| `ng serve` grows past 6 GB | `build/package-scripts` | `--max_old_space_size` larger than RAM postpones GC; use 8192. |
| Deploy uploads an empty or old site | `build/application-builder-output` | The output is `dist/<app>/browser` now; fix the CI/deploy paths. |
| Trailing dropdown icons jump left, `.mat-button` overrides stop matching, every menu row gets a scrollbar | `material/button-trailing-icon`, `material/mdc-style-overrides` | `iconPositionEnd`; `.mat-mdc-button` / `.mdc-button__label`; `overflow: hidden` instead of `overflow-x` and hide `.mat-mdc-button-touch-target`. |
| Chips no longer wrap/space properly; `<mat-chip-list>` renders as a plain element | `material/mdc-chip-list` | `<mat-chip-set>` for display-only chips (auto-fix); `mat-chip-listbox` (selection) or `mat-chip-grid` (input) by hand. |
| A sidenav with perfect-scrollbar doesn't grow when a sub-menu opens | `deps/perfect-scrollbar-content` | Prefer native `overflow-y: auto`. |
| VS Code's extension host crashes (1.9 GB) | `workspace/vscode-watcher-exclude` | `ngx-upgrade-doctor vscode`. |
| "Type X is part of the declarations of 2 modules" | `core/component-in-two-modules` | Declare it once and export it. |

## Commands

| Command | When | What it does |
|---|---|---|
| `scan --target <N>` | before `ng update` | Blockers (break on N), warnings (deprecated on N) and suggestions. Exits 1 on blockers. |
| `fix --target <N>` | before `ng update` | Applies auto-fixes; lists the ones deferred until N is installed. |
| `current` | any time, no upgrade | Warnings and errors for the installed version only. |
| `deps --target <N>` | before `ng update` | Per package: `ng update`, upgrade (with version), remove or replace, plus the commands in order. |
| `plan [--target 22]` | once, at the start | Every hop with its Node and TypeScript requirements and commands. |
| `types` | on v22+ | Adds explicit types to variables, parameters, properties and return types. |
| `strict` | after `types`, or any time with `strict: true` | Fixes TS2564, TS2322 (`null`/`undefined`), TS7053, TS7015, TS7016 and TS18048 (possibly `undefined`) compiler errors; `--enable` turns strict mode on. |
| `finalize` | after upgrading to v22 | Compatible libraries, every auto-fix from any version (styles included), subscribe observer style, types, cache clean, final check — see [Finalizing](#finalizing-an-angular-22-upgrade). |
| `vscode` | once per workspace | Writes `.vscode/settings.json` (merging your own keys) with `files.watcherExclude`/`search.exclude` for `node_modules`, `.angular` and `dist`, `typescript.tsserver.maxTsServerMemory: 3072` and no automatic type acquisition — keeps VS Code's extension host from crashing on big apps. |
| `rules` | any time | Lists every rule with its version range. |

### Options

| Option | Commands | Meaning |
|---|---|---|
| `--project <dir>` | all | Workspace root (default: current folder) |
| `--dry-run` | `fix`, `current --fix`, `types`, `strict`, `deps --apply`, `finalize` | Show what would change, write nothing |
| `--json` | `scan`, `current`, `deps` | Machine-readable output |
| `--verbose` | all | Show every finding |
| `--fix` / `--tsc` / `--all` | `current` | Apply fixes / add TypeScript errors / include suggestions |
| `--install` | `fix`, `current --fix` | Run `npm install` when a fix changed package.json (otherwise you are asked; CI just gets the command) |
| `--online` | `deps` | Resolve versions from the npm registry |
| `--latest` | `deps --online` | Suggest the newest compatible release instead of the smallest upgrade |
| `--apply`, `--yes`, `--allow-dirty`, `--ng-force`, `--legacy-peer-deps` | `deps` | Run the upgrade commands — see [Automatic upgrade](#automatic-upgrade) |
| `--mode`, `--yes`, `--no-specs`, `--skip-callbacks`, `--force` | `types` | See [Explicit types](#explicit-types-v22) |
| `--yes`, `--skip-deps`, `--skip-types`, `--offline`, `--no-tsc`, `--mode` | `finalize` | See [Finalizing an Angular 22 upgrade](#finalizing-an-angular-22-upgrade) |
| `--yes`, `--no-specs`, `--enable`, `--force` | `strict` | See [Strict-mode errors](#strict-mode-errors); `--enable` turns `"strict": true` on after fixing what it breaks |
| `--ignore-invalid` | `deps --apply` | Run `ng update` even though `npm ls` reports "invalid" packages (it normally stops first and names them) |

`ngx-upgrade-doctor --target 8` is shorthand for `scan --target 8`.

## Example

```text
$ ngx-upgrade-doctor scan --target 8

✖ BLOCKER @angular/http was removed in v8 (core/angular-http, v7-8)
    src/app/customers/customer.service.ts:2  Import from @angular/http
    → Replace HttpModule → HttpClientModule, Http → HttpClient ...

⚠ WARNING RxJS 5-style deep imports (rxjs/deep-imports, v6-9) [auto-fix]
    src/app/customers/customer.service.ts:3  Deep import 'rxjs/Observable' (auto-fixable)
    src/app/customers/customer.service.ts:7  Patch import 'rxjs/add/operator/catch' (manual)

⚠ WARNING String-based loadChildren (router/string-load-children, v7-8) [auto-fix]
    src/app/app-routing.module.ts:5  String loadChildren (auto-fixable)

Summary: 4 blocker(s), 13 warning(s), 1 suggestion(s); 8 auto-fixable
```

## What it checks

| Hop | Rules | Auto-fix |
|---|---|---|
| every hop | Node, TypeScript, RxJS and zone.js versions | – |
| v6–9 | rxjs deep imports (`rxjs/Observable`, `rxjs/operators/map`, `fromPromise` → `from`), `rxjs-compat` | ✔ (patch imports `rxjs/add/*` are manual) |
| v7–8 | `@angular/http` removed, string `loadChildren`, `@ViewChild` static flag, core-js 2 paths | ✔ loadChildren, core-js |
| v8–9 | `entryComponents`, `Renderer` v1, `TestBed.get` | ✔ entryComponents, TestBed |
| v9–10 | `ModuleWithProviders<T>`, `enableIvy: false`, `ngcc` postinstall | ✔ |
| v10–11 | `async` → `waitForAsync` | ✔ |
| v11–12 | node-sass → sass, TSLint → ESLint, Material `@use` theming, `zone.js/dist`, Protractor | ✔ sass, theming, zone |
| v12–13 | View Engine libraries, `~` Sass imports, IE11 browserslist, ComponentFactoryResolver | ✔ `~`, IE11 |
| v13–14 | `defaultProject`, untyped forms | ✔ defaultProject |
| v14–17 | flex-layout, class guards, legacy Material → MDC imports and Sass, MDC style overrides | ✔ legacy imports |
| v17+ | control flow, standalone, application builder, `@nguniversal` → `@angular/ssr`, `HttpClientModule` | hints + official schematics |
| v20+ | `@angular/animations`, zoneless, Karma → Vitest | hints |
| v22 | explicit types | `types` command |

Rules by name (one line each; `npx ngx-upgrade-doctor rules` prints them all with their version ranges):

| Rule | From | What it catches | Auto-fix |
|---|---|---|---|
| `deps/missing-packages` | every hop | Imports of packages not in package.json (comment-aware; e2e/spec files are warnings) | – |
| `rxjs/compat-imports-without-package` | every hop | RxJS 5 imports with no rxjs-compat installed | – |
| `rxjs/deep-imports` (extended) | v6+ | `rxjs/internal/*` public symbols, `rxjs/Rx` named imports, single patch operators, unused `rxjs/add/*` | ✔ |
| `rxjs/subject-next-without-value` | v22 | `subject.next()` on a non-void Subject (TS2554 with RxJS 7) | ✔ `next(undefined)` |
| `env/rxjs-version`, `rxjs/compat-package` | v22 | RxJS 6 / rxjs-compat now blockers | – |
| `env/node-version` (extended) | every hop | Supported majors, no-longer-supported majors, nvm-installed versions that fit | – |
| `deps/known-incompatible` | v13+ | ngx-perfect-scrollbar, ngx-material-timepicker, ngx-webcam, ngx-image-cropper, ng2-pdf-viewer, ngx-charts, angular-calendar, date-fns | – (`deps` commands) |
| `polyfills/core-js-unneeded` | v15+ | `core-js/es*` imports in polyfills | ✔ removes them |
| `material/legacy-components` (extended) | v15–17 | `MatLegacy*`/`getMatLegacy*` from MDC entry points | ✔ |
| `material/theme-positional-palettes` | v15+ | `define-light-theme($p, $a, $w)` and `m2-define-*`, any namespace | ✔ config map |
| `material/mdc-style-overrides` (extended) | v15+ | Overrides of ~100 old internal classes (form field, select, option, buttons, checkbox, radio, tabs, chips, list, card, dialog, menu, table, …), `overflow-x` on MDC buttons | ✔ renames to the MDC classes |
| `material/form-field-appearance` | v15+ | `appearance="legacy"`/`"standard"`, `floatLabel="never"` (removed) | ✔ |
| `material/select-selection-indicator` | v16+ (opt-in) | The ✓ on single-selection `mat-select`/`mat-autocomplete` | ✔ `hideSingleSelectionIndicator` |
| `material/input-in-option` | v15+ | An `<input>` inside `<mat-option>` | – |
| `material/button-trailing-icon` | v15+ | Trailing `<mat-icon>` in MDC buttons | ✔ `iconPositionEnd` |
| `material/conflicting-button-variants` | v22 | `mat-raised-button` + `mat-mini-fab` on one element (NG8023) | ✔ |
| `deps/flex-layout` | v15 (blocker v19) | Runtime crash on v19+ | ✔ → `@ngbracket/ngx-layout@^N` |
| `deps/common-directive-constructors` | v19 | Libraries calling the old NgClass/NgStyle constructors | – |
| `deps/removed-angular-apis` | v22 | Library bundles importing removed Angular exports | – |
| `deps/library-api-renames` | v22 | ngx-material-timepicker → ngx-mat-timepicker, `ImageCropperModule` | ✔ |
| `deps/jspdf-2-breaking-api` | every hop | jspdf 1 APIs removed in 2 | – (check) |
| `deps/perfect-scrollbar-content` | v15+ | perfect-scrollbar around expanding content (info) | – |
| `ivy/view-engine-libraries` (extended) | v13+ | Unused View Engine libraries are warnings | – |
| `lint/tslint` | v11+ | Now a warning: TSLint never blocks `ng build` | – |
| `core/duplicate-metadata-entries` | v18 | The same entry twice in `imports`/`declarations`/`providers` | ✔ |
| `core/component-in-two-modules` | every hop | A component declared in two NgModules | – |
| `core/component-factory-resolver` (extended) | v13 (blocker v22) | Removed in v22; dead files noted | ✔ ViewContainerRef pattern |
| `core/hammer-loader` | v22 | `HammerLoader`/`HAMMER_LOADER` | – |
| `http/http-client-module` (extended) | v18+ | Only real `imports:` entries | – |
| `template/style-relative-url` | v19+ | `url()` in template `<style>`, `^` URLs on esbuild | ✔ builder-aware |
| `sass/module-system` | v19+ | Sass `@import` and global built-ins (incl. `blue()`) | – (sass-migrator) |
| `template/control-flow-auto-migration` | v21 | `ng update` rewrites all structural directives | – |
| `template/structural-trailing-separator` | v17 (blocker v21) | `*ngIf="a,"` → NG5002 after migration | ✔ |
| `template/invalid-html` | v17+ | Glued attributes, unbalanced tags | ✔ glued attributes |
| `template/loop-variable-named-in` | v17 (blocker v22) | `let in of` / `@for (in of …)` | ✔ rename + `track $index` |
| `template/parse-errors` | `current` | Template parse errors from the project's own `@angular/compiler` | – |
| `router/relative-link-above-root` | v21 | `../` links above the root (NG04005) | ✔ layout/menu links |
| `types/uint8array-buffer-source` | v21 (TS < 5.9) | `Uint8Array` into `crypto.subtle` | ✔ return/property types |
| `ts/strict-default` | v22 | TS 6 strict default | ✔ `"strict": false` |
| `ts/called-namespace-import` | v17 (blocker v22) | `import * as X` used as `X()` / `new X()` | ✔ default import |
| `ts/deprecated-options` | v22 | `baseUrl`, `downlevelIteration` (TS5101) | ✔ narrow `paths` |
| `build/extended-diagnostics-without-strict-templates` | v22 | NG4003 | ✔ |
| `build/esbuild-external-dependencies` | v17+ | jsdom pulled into the browser bundle | ✔ `externalDependencies` |
| `build/application-builder-output` | v17+ | Deploy/CI files copying `dist/<app>` instead of `dist/<app>/browser` | – |
| `build/package-scripts` | every hop | Webpack-only flags, duplicate `--configuration`, `npm run x --flag`, huge `--max_old_space_size` | ✔ flags, `--` |
| `build/file-name-case` | every hop | References in the wrong letter case | ✔ |
| `workspace/vscode-watcher-exclude` | every hop | VS Code watching node_modules (info) | `vscode` command |
| `material/mdc-slider` | v15 (blocker v17) | Pre-MDC `mat-slider` (`thumbLabel`, `tickInterval`, bindings on `<mat-slider>`) | ✔ `<input matSliderThumb>` |
| `deps/for-root-removed` | every hop | `NgxMaterialTimepickerModule.forRoot()` with timepicker 13+ | ✔ |
| `deps/build-angular-peers` | every hop | `webpack` peer skipped by `--legacy-peer-deps` | – (install command) |
| `deps/perfect-scrollbar-fork` | v16 | ngx-perfect-scrollbar → ngx-om-perfect-scrollbar | ✔ |
| `build/sass-in-css` | v17+ | Sass (`$var:`, `@include`, `//`) inside a `.css` file: "Unexpected \"$\"" | ✔ rename to `.scss`, update `styleUrl(s)` |
| `deps/not-installed` | every hop | Packages in package.json missing from node_modules (e.g. after a library swap) | – (`npm install`) |
| `build/build-angular-package` | v20+ | Deprecated `@angular-devkit/build-angular:application/dev-server/extract-i18n` | ✔ → `@angular/build:*` + devDependency |
| `build/dev-server-settings` | v17+ | `outputHashing: all` in the served configuration (HMR off), build cache disabled | – |
| `deps/invalid-installed` | every hop | Installed packages `npm ls` calls "invalid" (e.g. `rxjs@7.8.2` wanted at another range by an old library), which make `ng update` stop with ELSPROBLEMS | – (names the package to upgrade/uninstall) |
| `deps/cli-temp-folders` | every hop | Leftover `angular-cli-tmp-packages-*` from an interrupted `ng update` | ✔ removes them |
| `rxjs/subscribe-observer-style` | v12+ (opt-in) | Every inline-callback `subscribe` in `{ next: … }` style (suggestion; fixed only with `--only`) | ✔ |
| `material/mdc-chip-list` | v15+ | `<mat-chip-list>`, removed in v17 (chips lose their layout) | ✔ `<mat-chip-set>` for display-only lists |
| `rxjs/subscribe-callbacks` | v12+ (RxJS 7) | `subscribe(next, error, complete)`, deprecated in RxJS 7 | ✔ `subscribe({ next, error, complete })` |

Run `ngx-upgrade-doctor rules` for the full list.

## Dependency advice

```bash
ngx-upgrade-doctor deps --target 12 --online
```

For every dependency it says what to do and prints the commands in order. Installs are split by where each package already lives in `package.json`:

```text
Commands (in order):
  ng update          npx ng update @angular/core@7 @angular/cli@7 @angular/material@7
  dependencies       npm install --save "@ng-bootstrap/ng-bootstrap@^4.2.2" "ngx-toastr@^10.2.0" "rxjs@^6.3.0"
  devDependencies    npm install --save-dev "typescript@>=3.1.1 <3.3.0"
```

| Step | Command | What goes in it |
|---|---|---|
| 1 | `npx ng update …` | Angular, the CLI and Material/CDK; then `@ngrx/store` and `@angular-eslint/schematics` so their migrations run |
| 2 | `npm uninstall …` | Packages removed at this version (`@angular/http`, `rxjs-compat`, `node-sass`) — only if no source file still imports them |
| 3 | `npm install --save …` | Upgrades for packages in `dependencies` |
| 4 | `npm install --save-dev …` | Upgrades for packages in `devDependencies`, plus replacements such as `sass` for `node-sass` |
| – | By hand | Replacements that need a decision (TSLint → ESLint, Protractor → Cypress/Playwright, flex-layout), packages still imported, packages with no compatible version |

- **Offline:** Angular's own Node/TypeScript/RxJS/zone.js ranges, packages released in step with Angular (`@ngrx/*`, `@angular-eslint/*`, `@angular-builders/*`), a built-in table for popular libraries (ng-bootstrap, ngx-bootstrap, PrimeNG, ngx-toastr, ngx-translate, ng2-charts), and the `peerDependencies` of what is in `node_modules`.
- **`--online`:** reads each package's `peerDependencies` from the npm registry and treats them as the source of truth:
  - If your current version already accepts Angular N, it says `ok` and changes nothing.
  - Otherwise it suggests the **smallest upgrade**: the newest release of the lowest major at or above yours that accepts Angular N. Many libraries declare open-ended peers such as `>=13`, so their newest major is often a much bigger jump than the upgrade needs (e.g. `@zxing/ngx-scanner` 3.5 → `^3.9.1` for Angular 15, not `^20`). Add `--latest` for the newest compatible release instead.
  - It **never suggests a downgrade**: if only older releases accept Angular N, the package is listed under "By hand".
  - If no release accepts Angular N, the package is listed under "By hand" and is **never uninstalled** — find an alternative or fork it.

### Automatic upgrade

Add `--apply` and the tool runs those commands for you, in order, in the workspace root:

```bash
git commit -am "before Angular 8"                     # ng update needs a clean tree
ngx-upgrade-doctor deps --target 8 --online --apply   # shows the commands, asks y/N, runs them
ngx-upgrade-doctor current --fix --tsc
ng build && ng test --watch=false
```

| Option | What it does |
|---|---|
| `--apply` | Runs the commands after showing them and asking `Run these commands now? (y/N)` |
| `--apply --dry-run` | Shows the commands, runs nothing |
| `--apply --yes` | Runs without asking (for scripts and CI) |
| `--allow-dirty` | Passes `--allow-dirty` to `ng update` so it runs with uncommitted changes |
| `--ng-force` | Passes `--force` to `ng update` to get past peer dependency conflicts |
| `--legacy-peer-deps` | Uses npm's legacy peer resolution for every command — often needed on old hops |

Safety rules:

- It stops at the first command that fails and tells you which; the commands before it are safe to run again.
- It only runs one hop: `--apply` refuses a target more than one major above the installed version.
- It never uninstalls a package that your source code still imports — those are listed under "By hand".
- It drives npm only. In a yarn, pnpm or bun project it prints the commands and refuses to run them.
- Without a terminal to answer the prompt (CI), it runs nothing unless you pass `--yes`.
- It warns about dependencies installed from git or a URL (in `package.json` or `package-lock.json`) before you install — see below.

### Troubleshooting installs

| Error | Cause | Fix |
|---|---|---|
| `git dep preparation failed` … `Cannot read properties of null (reading 'pickAlgorithm')` | npm 8 (Node 16/18) fails to prepare a dependency installed from git, usually with a stale npm cache. `deps` lists these under "Installed from git or a URL". | 1. `npm cache clean --force`, then retry. 2. Still failing: delete `node_modules` and `package-lock.json`, then `npm install --legacy-peer-deps`. 3. Lasting fix: replace the git dependency with a published npm version. |
| `ERESOLVE unable to resolve dependency tree` | Peer dependency conflict, common on old hops | Re-run with `--legacy-peer-deps`. Prefer it over `npm install --force`, which can install broken combinations. |
| `ng update` fails with `npm error code ELSPROBLEMS` (`extraneous: angular-cli-tmp-packages-…`, `invalid: rxjs@7.8.2`) | `ng update` runs `npm ls` first and stops on any problem. An interrupted `ng update` leaves `angular-cli-tmp-packages-*` folders, and an old library that wants another rxjs version makes rxjs "invalid". `--ng-force` does not skip this. | `deps --apply` removes the leftover temp folders and uninstalls stale libraries **before** `ng update`. For the rest it prints the fix: `npm ls rxjs` shows which package wants another version; upgrade or uninstall it, then `npm install --legacy-peer-deps`. |
| `'ngx-upgrade-doctor' is not recognized as an internal or external command` | It isn't installed globally | Use `npx ngx-upgrade-doctor …` (every command the tool prints now does), or `npm i -g ngx-upgrade-doctor`. |
| `ng update` says the repository is not clean | `ng update` needs committed changes | Commit first, or add `--allow-dirty`. |
| `ng update` reports incompatible peer dependencies | A library has no release for the new Angular yet | Check that library in the `deps --online` table; `--ng-force` only if you accept the risk. Libraries that `deps` marks "upgrade" and that peer on Angular are already added to the same `ng update` command. |
| `The Angular CLI requires a minimum Node.js version of v22.22.3 …` (exit code 3) | The Node version doesn't fit the target CLI's `engines.node` | `nvm install 24 && nvm use 24` (or a listed installed version). `deps --apply` checks this first and prints the fix. |
| `Module not found` for a package you just removed | A stale build cache still holds compiler-generated imports | Delete `.angular/cache` (`rm -rf .angular/cache`, Windows: `rmdir /s /q .angular\cache`) before `ng serve`. `deps` prints this after every plan. |
| `Could not resolve "ngx-mat-timepicker"` / TS2307 right after `current --fix` | The fix swapped a library in package.json, but `npm install` wasn't run | From 0.4.2, `fix` / `current --fix` asks to run `npm install` right away (`--install` runs it without asking, `--legacy-peer-deps` is passed on). In CI it prints the exact command. `deps/not-installed` lists what is still missing. |
| `Unexpected "$" [css-syntax-error]` in a `.css` file | Sass written in a `.css` file; esbuild reads it as plain CSS and drops those rules | `build/sass-in-css` renames it to `.scss` and updates `styleUrl(s)`. |
| `The "@angular-devkit/build-angular:dev-server" builder is deprecated` | The esbuild builders moved to `@angular/build` | `build/build-angular-package` switches the builders and adds `@angular/build`; then `npm install`. |
| `HMR is disabled because the 'outputHashing' option is set to 'all'` / `Prebundling … caching has been disabled` | The served configuration hashes file names; `cli.cache.enabled` is false | `build/dev-server-settings` points at both: `"outputHashing": "none"` for the configuration you serve, and re-enable the cache. |
| `... is not exported under the conditions` (`@babel/runtime/helpers/esm/…`) | `date-fns` < 2.30 with `@babel/runtime` 8 | `npm i date-fns@^2.30.0` |
| ~100 `Could not resolve "util"/"crypto"/"fs"` (esbuild) | `fabric@<6` / `canvg@<2` pull in `jsdom` | `"externalDependencies": ["jsdom"]` in the build options (`fix` adds it). |

### Fixing misaligned screens after the MDC rewrite

From v15, Angular Material components are built on MDC: new DOM, new class names, new defaults. The build passes, but screens look wrong — labels overlap arrows, fields have different heights or grey boxes, dropdowns show a check mark, a search box sits in a blank row. This happens most after an upgrade done without the per-hop fixes. On v15+, `current --fix` (or `finalize` on v22) repairs what it can:

| Symptom | Cause | Rule | Fix |
|---|---|---|---|
| Labels overlap the dropdown arrow; paddings, heights and spacing are off; custom dropdown/option styles are ignored | Overrides of old internal classes (`.mat-form-field-infix`, `.mat-select-arrow-wrapper`, `.mat-select-panel`, `.mat-option`, …) no longer match anything | `material/mdc-style-overrides` | ✔ Renamed to the MDC classes (`.mat-mdc-form-field-infix`, `.mat-mdc-select-arrow-wrapper`, `.mat-mdc-select-panel`, `.mat-mdc-option`, …) in stylesheets and inline `styles`. Classes your templates use themselves are kept; nothing is renamed while `MatLegacy*` components are imported; classes with no MDC equivalent are listed. |
| Some fields have a grey background and are taller, others are underlined | `appearance="legacy"`/`"standard"` were removed and fall back to `fill`; `floatLabel="never"` was removed | `material/form-field-appearance` | ✔ Attributes removed so one app-wide default applies; default options mapped to `fill`/`auto`. Choose the look once with `MAT_FORM_FIELD_DEFAULT_OPTIONS` (e.g. `{ appearance: 'outline', subscriptSizing: 'dynamic' }`). |
| A ✓ appears at the end of the selected option in single-selection dropdowns | v16+ shows a selection indicator | `material/select-selection-indicator` (opt-in) | ✔ `hideSingleSelectionIndicator` on each `mat-select`/`mat-autocomplete` (applied by `finalize`, or `current --fix --only material/select-selection-indicator`) |
| The search box inside a dropdown gets a ✓/hover background, or Space closes the panel | An `<input>` inside a `<mat-option>` is a selectable row in MDC | `material/input-in-option` | – Use `ngx-mat-select-search`, or put the input above the options with `(keydown)="$event.stopPropagation()"` |
| An empty row and a grey box above the options of a searchable dropdown | `ngx-mat-select-search` older than 7 is built for the legacy select | `deps/known-incompatible` | `deps --online --apply` (or `finalize`) upgrades it: `^7.0.0` on v15+, the latest `^9.0.0` on v22 |

Then review each screen in the browser: the MDC DOM is different, so values tuned for the old DOM (negative margins, fixed heights) may still need adjusting. For lasting changes prefer the component tokens and mixins (`mat.form-field-overrides`, `mat.select-overrides`, v18+) over `::ng-deep` overrides.

### Troubleshooting runtime errors after upgrade

These pass `ng build` and fail in the browser. Each one has a rule:

| Console error | Cause | Fix |
|---|---|---|
| `ERROR RuntimeError: NG04005: Invalid number of '../'`, repeating non-stop (v21+) | A `routerLink="../x"` that climbs above the root used to be clamped to `/`; v21 throws, and `routerLink` re-evaluates on every change detection | `router/relative-link-above-root` makes layout/menu links absolute (`/x`). Check data-driven menu URLs from the server too. |
| `TypeError: this._renderer.addClass is not a function` (v19+) | `@angular/flex-layout`'s `ngClass`/`ngStyle` directives call the pre-v19 `NgClass`/`NgStyle` constructors | `deps/flex-layout` swaps it for `@ngbracket/ngx-layout@^N`; `deps/common-directive-constructors` finds other libraries doing the same. |
| `TypeError: X is not a constructor` / esbuild "Constructing … will crash at run-time because it's an import namespace object" | `import * as jsPDF from 'jspdf'` + `new jsPDF()` under the esbuild builder | `ts/called-namespace-import` switches to `import jsPDF from 'jspdf'`. |
| `ComponentFactoryResolver` / `HAMMER_LOADER` "is not exported" when a page loads (v22) | A library (or a not-yet-imported file of yours) uses an API removed in v22 | `deps/removed-angular-apis` and `core/component-factory-resolver` list them with the upgrade to install. |
| `NG0100: ExpressionChangedAfterItHasBeenCheckedError` noise | Usually old code that mutates bindings in `ngAfterViewInit`; dev-mode only, more visible after control-flow/zoneless changes | Move the change to `ngOnInit`, or wrap it in `queueMicrotask`/`setTimeout`; signals avoid it. Not a blocker for production builds. |
| Trailing icons jump left in buttons; menus get a scrollbar per row (v15+) | MDC buttons project `<mat-icon>` first and contain a 48px touch target | `material/button-trailing-icon` adds `iconPositionEnd`; use `overflow: hidden` instead of `overflow-x: hidden` on buttons and hide `.mat-mdc-button-touch-target` in dense menus. |

### Memory: `--max_old_space_size`

Big apps often carry `node --max_old_space_size=…` in their scripts. A value larger than physical RAM (such as `80000`) does not help. It makes Node postpone garbage collection, so `ng serve` keeps growing (6 GB+). `8192` is plenty. `build/package-scripts` warns above the machine's RAM or 16384 MB.

## Explicit types (v22+)

Once you are on v22, `scan`, `fix` and `current` count declarations without a written type and offer to add them. The `types` command does it:

```bash
ngx-upgrade-doctor types --dry-run --verbose   # preview every change
ngx-upgrade-doctor types                       # choose a mode, review, confirm y/N
ngx-upgrade-doctor types --mode infer --yes    # no prompts
```

| Mode | Writes |
|---|---|
| `infer` (default) | The type TypeScript infers: `count: number`, `names(): string[]`, `(u: User): string`. A type that cannot be written in that file (e.g. `typeof import(...)`) is left to inference rather than replaced by `any`. |
| `any` | `: any` on every parameter, variable, property and return type. |
| `implicit-any` | `: any` only where `noImplicitAny` reports an error. |
| `nullable` | `: any` only on the local variables, callback parameters and `catch` variables that strict null checks report as possibly `undefined`/`null`/`unknown` (TS18048, TS18047, TS2532, TS18046) — e.g. `const res = await x.toPromise()` (RxJS 7 types it `T \| undefined`) or `subscribe(res => res.data)`. The smallest change that gets a strict build through. |

Every file is type-checked with the new types before it is written; a file that would gain compiler errors is skipped and listed. Not annotated: destructured variables, `for…of`/`for…in` variables, constructors, setters and generators.

After the types pass, the tool checks for strict-mode errors and offers to fix them (`--yes` fixes them without asking).

## Strict-mode errors

Projects written before `"strict": true` fail `ng build` with hundreds of errors even after every declaration has a type. The `strict` command fixes the common ones without changing what the code does at runtime — every edit is a type-level assertion:

```bash
ngx-upgrade-doctor strict --dry-run --verbose   # preview every fix
ngx-upgrade-doctor strict                       # review, confirm y/N
ngx-upgrade-doctor strict --yes                 # no prompt
```

| Error | Example | Fix |
|---|---|---|
| TS2564 property has no initializer | `items: any[];` | `items!: any[];` — it is assigned later (ngOnInit, a subscribe, @Input) |
| TS2322 `null`/`undefined` not assignable | `this.code = undefined;` · `photo: Photo = null;` | `this.code = undefined as any;` · `= null as any;` |
| TS7053 dynamic key on a class | ``this[`field${i}`] = e;`` · `this[name] = '';` | ``(this as any)[`field${i}`] = e;`` |
| TS7015 string index on a non-object | `this.account['id']` | `(this.account as any)['id']` |
| TS18048 / TS2532 / TS18047 possibly `undefined`/`null` | `const res = await this.http.get(url).toPromise();` `res.data` · `subscribe(res => res.data)` | `const res: any = …` · `subscribe((res: any) => res.data)` — only for untyped locals and callback parameters; explicitly typed ones are left to you |
| TS18046 catch variable is `unknown` | `catch (err) { err.message }` | `catch (err: any)` |
| TS7016 package without types | `import * as CryptoJS from 'crypto-js';` | adds `declare module 'crypto-js';` to `src/typings.d.ts` (or a new `src/untyped-modules.d.ts`) and prints `npm install --save-dev @types/crypto-js` — the better fix where it exists |

Like the types pass, every file is recompiled before it is written; a file that would gain errors is skipped and listed. Errors the tool does not fix (for example a possibly-`undefined` property, or a `for…of` variable, which cannot carry a type) are listed at the end so you can fix them by hand. Template errors only show in `ng build`, so run it afterwards.

### Turning strict mode on (`strict --enable`)

Projects that kept `"strict": false` (the TS 6 fix `ts/strict-default` writes it to keep a v22 upgrade building) can switch it on in one step:

```bash
npx ngx-upgrade-doctor strict --enable --dry-run --verbose   # what turning strict on would break, and the fixes
npx ngx-upgrade-doctor strict --enable                       # apply the fixes, then set "strict": true
```

- It type-checks as if the tsconfig said `"strict": true`, ignoring explicit `strictNullChecks: false`-style overrides, and plans the same fixes as above.
- After applying them it sets strict mode in the tsconfigs:
  - every `"strict": false` becomes `true`; if no tsconfig sets it, `"strict": true` is added to `tsconfig.json`;
  - explicit `false` strict-family flags (`noImplicitAny`, `strictNullChecks`, `strictPropertyInitialization`, …) are removed, because they would override it.
- The tsconfig is only switched when **no errors remain**, so the build never breaks. Otherwise the fixes are kept, the remaining errors are listed, and you re-run it after fixing them. `--force` switches anyway.

These fixes keep the build green; they are not good types. Over time, replace `!` with a real initial value (`items: any[] = [];`), `as any` with `T | null`, and `(this as any)[key]` with a typed map such as `scores: Record<string, string> = {}`.

## Use in CI

```yaml
- run: npm ci                                   # installs ngx-upgrade-doctor from devDependencies
- run: npx ngx-upgrade-doctor scan --target 18
```

The step fails while blockers remain. Use `--json` to feed the results into other tools.

## Programmatic API

```ts
import { Project, scan, fix, adviseDeps, planTypes, applyTypePlan, planStrictFixes } from 'ngx-upgrade-doctor';

const project = new Project(process.cwd());
const results = scan({ project, mode: 'target', target: 12 });
const advice = await adviseDeps({ project, target: 12, online: true });

// Fix "possibly 'undefined'" locals, then write the files.
applyTypePlan(project, planTypes(project, { mode: 'nullable' }));
project.flush(false);
```

TypeScript declarations are included.

## Adding a rule

Each rule is one object in `src/rules/`:

```ts
const myRule: Rule = {
  id: 'material/some-change',
  hop: 'v15-17',
  title: 'What breaks',
  since: 15,           // starts mattering here
  deprecatedIn: 15,    // warning from here
  removedIn: 17,       // blocker from here
  fixRequires: 15,     // the fix compiles once this version is installed
  hint: 'How to fix it by hand',
  check: ({ project }) => scanFiles(project, tsFiles(project), /pattern/, 'message'),
  fix: ({ project }) => transformFiles(project, tsFiles(project), (text) => text.replace(/x/g, 'y')),
};
```

Add it to the file's exported list, add a case to `test/fixtures`, and run `npm test`. Pull requests with new rules are welcome.

## Rule reference

Every rule, the hop it belongs to, the versions it applies to and its auto-fix. Severity is the default; some findings escalate or soften case by case. For example, RxJS 6 is a blocker from v22, and files outside the build graph or e2e tsconfigs are only warnings.

| Rule | Hop | Applies | Severity | Auto-fix |
|---|---|---|---|---|
| `env/node-version` | every hop | v6+ | blocker from v6 | – |
| `env/typescript-version` | every hop | v6+ | warning from v6 | – |
| `env/rxjs-version` | every hop | v6+ | warning from v6 | – |
| `env/zone-version` | every hop | v6+ | warning from v6 | – |
| `deps/missing-packages` | every hop | v6+ | blocker from v6 | – |
| `rxjs/deep-imports` | v6-9 | v6+ | warning from v6 | ✔ |
| `rxjs/compat-imports-without-package` | every hop | v6+ | blocker from v6 | – |
| `rxjs/compat-package` | v6-12 | v6+ | warning from v8 | – |
| `rxjs/subject-next-without-value` | v21-22 | v22+ | blocker from v22 | ✔ |
| `core/angular-http` | v7-8 | v6+ | blocker from v8 | – |
| `router/string-load-children` | v7-8 | v8+ | blocker from v13 | ✔ |
| `core/view-child-static` | v7-8 | v8–8 | warning | – |
| `polyfills/core-js-es7` | v7-8 | v8+ | warning from v8 | ✔ |
| `ivy/entry-components` | v8-9 | v9+ | warning from v9 | ✔ |
| `core/renderer-v1` | v8-9 | v6+ | blocker from v9 | – |
| `testing/testbed-get` | v8-9 | v9+ | warning from v9 | ✔ |
| `core/module-with-providers-generic` | v9-10 | v9+ | blocker from v10 | ✔ |
| `ivy/enable-ivy-false` | v9-13 | v9+ | blocker from v13 | ✔ |
| `ivy/ngcc-postinstall` | v9-16 | v9+ | blocker from v16 | ✔ |
| `testing/async-to-wait-for-async` | v10-11 | v11+ | warning from v11 | ✔ |
| `build/node-sass` | v11-12 | v8+ | blocker from v12 | ✔ |
| `lint/tslint` | v11-12 | v11+ | warning from v11 | – |
| `material/legacy-theming-api` | v11-12 | v12+ | warning from v12 | ✔ |
| `polyfills/zone-dist-imports` | v11-12 | v12+ | blocker from v15 | ✔ |
| `testing/protractor` | v12-15 | v12+ | blocker from v15 | – |
| `styles/tilde-imports` | v12-13 | v13+ | warning from v13 | ✔ |
| `ivy/view-engine-libraries` | v12-13 | v13+ | blocker from v16 | – |
| `core/component-factory-resolver` | v12-22 | v13+ | blocker from v22 | ✔ |
| `core/hammer-loader` | v21-22 | v22+ | blocker from v22 | – |
| `build/ie11-browserslist` | v12-13 | v13+ | warning from v13 | ✔ |
| `workspace/default-project` | v13-14 | v14+ | warning from v14 | ✔ |
| `forms/untyped-forms` | v13-14 | v14+ | info | – |
| `deps/known-incompatible` | v12-16 | v13+ | blocker from v13 | – |
| `polyfills/core-js-unneeded` | v14-16 | v15+ | warning from v15 | ✔ |
| `deps/flex-layout` | v14-19 | v15+ | blocker from v19 | ✔ |
| `router/class-guards` | v14-15 | v15+ | info | – |
| `material/legacy-components` | v15-17 | v15+ | blocker from v17 | ✔ |
| `material/mdc-style-overrides` | v15-17 | v15+ | warning from v15 | ✔ |
| `material/theme-positional-palettes` | v14-15 | v15+ | warning from v15 | ✔ |
| `deps/nguniversal` | v16-17 | v17+ | warning from v17 | – |
| `template/control-flow` | v17+ | v17+ | warning from v20 | – |
| `core/standalone` | v17+ | v15+ | info | – |
| `build/application-builder` | v17+ | v17+ | info | – |
| `core/duplicate-metadata-entries` | v17-18 | v6+ | warning from v18 | ✔ |
| `http/http-client-module` | v17-18 | v18+ | warning from v18 | – |
| `template/style-relative-url` | v18+ | v19+ | blocker from v19 | ✔ |
| `sass/module-system` | v18+ | v19+ | warning from v19 | – |
| `deps/common-directive-constructors` | v18-19 | v19+ | blocker from v19 | – |
| `template/control-flow-auto-migration` | v20-21 | v21–21 | warning | – |
| `template/structural-trailing-separator` | v20-21 | v17+ | blocker from v21 | ✔ |
| `template/invalid-html` | v17+ | v17+ | warning from v21 | ✔ |
| `types/uint8array-buffer-source` | v21+ | v21+ | blocker from v21 | ✔ |
| `router/relative-link-above-root` | v20-21 | v21+ | blocker from v21 | ✔ |
| `ts/strict-default` | v21-22 | v22+ | blocker from v22 | ✔ |
| `ts/called-namespace-import` | v17+ | v17+ | blocker from v22 | ✔ |
| `ts/deprecated-options` | v21-22 | v22+ | blocker from v22 | ✔ |
| `deps/removed-angular-apis` | v21-22 | v22+ | blocker from v22 | – |
| `deps/library-api-renames` | v21-22 | v22+ | blocker from v22 | ✔ |
| `template/loop-variable-named-in` | v21-22 | v17+ | blocker from v22 | ✔ |
| `material/conflicting-button-variants` | v21-22 | v22+ | blocker from v22 | ✔ |
| `build/extended-diagnostics-without-strict-templates` | v21-22 | v22+ | blocker from v22 | ✔ |
| `build/esbuild-external-dependencies` | v17+ | v17+ | blocker from v17 | ✔ |
| `deps/jspdf-2-breaking-api` | every hop | v6+ | warning | – |
| `build/file-name-case` | every hop | v6+ | warning | ✔ |
| `build/package-scripts` | every hop | v6+ | warning | ✔ |
| `build/application-builder-output` | v17+ | v17+ | warning | – |
| `material/mdc-slider` | v15-17 | v15+ | blocker from v17 | ✔ |
| `deps/for-root-removed` | v15-16 | v6+ | blocker from v6 | ✔ |
| `deps/build-angular-peers` | every hop | v6+ | blocker from v6 | – |
| `deps/perfect-scrollbar-fork` | v15-16 | v16+ | blocker from v16 | ✔ |
| `rxjs/subscribe-callbacks` | v12+ | v12+ | warning from v12 (with RxJS 7) | ✔ |
| `material/mdc-chip-list` | v15-17 | v15+ | warning from v15 | ✔ |
| `rxjs/subscribe-observer-style` | v12+ | v12+ | info (opt-in, `--only`) | ✔ |
| `build/sass-in-css` | v17+ | v17+ | warning from v17 | ✔ |
| `deps/not-installed` | every hop | v6+ | blocker from v6 | – |
| `build/build-angular-package` | v20+ | v20+ | warning from v20 | ✔ |
| `build/dev-server-settings` | v17+ | v17+ | warning | – |
| `deps/invalid-installed` | every hop | v6+ | warning | – |
| `deps/cli-temp-folders` | every hop | v6+ | blocker from v6 | ✔ |
| `material/form-field-appearance` | v15-17 | v15+ | warning from v15 | ✔ |
| `material/select-selection-indicator` | v16+ | v16+ | info (opt-in, `--only`, applied by `finalize`) | ✔ |
| `material/input-in-option` | v15-17 | v15+ | warning from v15 | – |
| `material/button-trailing-icon` | v15+ | v15+ | warning | ✔ |
| `deps/perfect-scrollbar-content` | v15+ | v15+ | info | – |
| `workspace/vscode-watcher-exclude` | every hop | v6+ | info | – |
| `core/component-in-two-modules` | every hop | v6+ | blocker from v6 | – |
| `animations/angular-animations` | v20+ | v20+ | warning from v21 | – |
| `core/zoneless` | v21+ | v21+ | info | – |
| `testing/karma` | v21+ | v21+ | info | – |
| `types/explicit-types` | v22 | v22+ | info | – |

## Notes

- Version requirements live in `src/versions.ts`. The v22 entry is marked to verify; confirm it at [angular.dev/reference/versions](https://angular.dev/reference/versions).
- Old hops need old Node versions (Angular 7 needs Node 8 or 10). Use [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows) to switch per hop.
- Always commit before `fix`, and review the diff.

## Support the project

`ngx-upgrade-doctor` is free and MIT-licensed, built and maintained in spare time. If it saved your team days of upgrade work, please consider supporting it:

- ❤️ [Sponsor on GitHub](https://github.com/sponsors/AzaruddinAM) — one-time or monthly; sponsorships fund new rules for each Angular release.
- ⭐ [Star the repository](https://github.com/AzaruddinAM/ngx-upgrade-doctor) — it helps other teams find the tool.
- 🐞 [Report an upgrade problem](https://github.com/AzaruddinAM/ngx-upgrade-doctor/issues) the tool missed — every rule here started as a real-world failure.

You can also run `npm fund` in a project that uses it to see the sponsor link.

## Professional help

Stuck on an old Angular version, or facing a large upgrade with a deadline? Paid help is available:

| Service | What you get |
|---|---|
| **Upgrade assistance** | Hands-on upgrade of your application across one or more major versions, hop by hop, with a reviewable commit per version. |
| **Upgrade assessment** | A written report on your workspace: blockers per hop, libraries to replace, effort estimate and recommended route. |
| **Priority support** | Faster fixes and custom rules for your company's own libraries and patterns. |
| **Team workshop** | A session on running large Angular upgrades with this tool: strict mode, Material/MDC, esbuild, dependencies. |

To get in touch, open an issue titled **"Professional help"** in the [repository](https://github.com/AzaruddinAM/ngx-upgrade-doctor/issues/new?title=Professional%20help) or contact me through my [GitHub profile](https://github.com/AzaruddinAM).

## Contributing

Issues and pull requests are welcome. To work on the tool:

```bash
npm install
npm test          # builds with tsc, then runs the node:test suite against test/fixtures
```

A new rule needs a fixture case and a test; see [Adding a rule](#adding-a-rule).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
