# ngx-upgrade-doctor

[![npm version](https://img.shields.io/npm/v/ngx-upgrade-doctor.svg)](https://www.npmjs.com/package/ngx-upgrade-doctor)
[![npm downloads](https://img.shields.io/npm/dm/ngx-upgrade-doctor.svg)](https://www.npmjs.com/package/ngx-upgrade-doctor)
[![license](https://img.shields.io/npm/l/ngx-upgrade-doctor.svg)](https://opensource.org/licenses/MIT)
[![node](https://img.shields.io/node/v/ngx-upgrade-doctor.svg)](https://nodejs.org)

**Know what will break before you run `ng update`.**
`ngx-upgrade-doctor` scans an Angular workspace for each major upgrade from **v6 to v22**, auto-fixes what it safely can, suggests compatible library versions, and adds explicit types once you reach v22.

> Built while migrating a production LOS app from Angular 6 to 22.

```bash
ngx-upgrade-doctor plan --target 22    # the whole route, hop by hop
ngx-upgrade-doctor scan --target 8     # what blocks the next hop?
```

---

## Why

Angular does not support skipping majors: an app on 6 goes 6 → 7 → 8 → … → 22. Each hop has its own traps — rxjs deep imports, Ivy, node-sass, TSLint, Material theming, View Engine libraries, the MDC rewrite, control flow. `ng update` migrates Angular's own code; it does not tell you about the rest. This tool does.

- **41 rules** across every hop, each with the file and line, a fix hint and a docs link
- **Safe auto-fixes**, with a `--dry-run` preview
- **Fixes that need a newer version wait**: they are deferred until after `ng update`, so your build never breaks in between
- **Dependency advice** checked against npm `peerDependencies`
- **Explicit-types pass** for v22+, type-checked before anything is written
- **CI-friendly**: `scan` exits with code 1 while blockers remain; `--json` output

## Install

Install it globally to get the `ngx-upgrade-doctor` command everywhere:

```bash
npm install -g ngx-upgrade-doctor
```

Or add it to the project, so everyone on the team uses the same version:

```bash
npm install --save-dev ngx-upgrade-doctor
```

With a project install, run the commands in this README with `npx` in front (`npx ngx-upgrade-doctor scan --target 8`); `npx` uses the copy in `node_modules`.

Requires Node.js 14.17 or newer to run the tool. Run it from your Angular workspace root, or pass `--project <dir>`. Update later with `npm install -g ngx-upgrade-doctor@latest`.

## The loop for every hop

| Step | Command |
|---|---|
| 1. Scan for blockers | `ngx-upgrade-doctor scan --target 8` |
| 2. Apply the safe fixes | `ngx-upgrade-doctor fix --target 8` |
| 3. Pick library versions | `ngx-upgrade-doctor deps --target 8 --online` |
| 4. Update Angular and libraries | `ngx-upgrade-doctor deps --target 8 --online --apply` — or run the printed commands yourself |
| 5. Apply the fixes that waited | `ngx-upgrade-doctor current --fix --tsc` |
| 6. Verify and commit | `ng build && ng test --watch=false` |

Then repeat for the next version. The official per-hop checklist is at [angular.dev/update-guide](https://angular.dev/update-guide).

## Version-by-version guide

### Before you start

1. **Commit everything** and create a branch, e.g. `git switch -c upgrade/angular-8`. Every hop should be one reviewable commit.
2. **Print your route:** `ngx-upgrade-doctor plan --target 22`.
3. **Install [nvm-windows](https://github.com/coreybutler/nvm-windows)** (or [nvm](https://github.com/nvm-sh/nvm) on macOS/Linux). The tool itself needs Node 14.17+, but `ng update` and `ng build` need the Node version of the hop — run the tool with a modern Node, then `nvm use` the hop's Node for the Angular commands. On hops below v12 the tool's Node check will therefore always flag the Node it runs on; that is the reminder of which Node to use for `ng`.
4. **Using Angular Material?** Add `@angular/material@N` to every `ng update` below (the tool's `deps` command prints it for you).
5. **Updates are automated:** every hop below uses `ngx-upgrade-doctor deps --target N --online --apply`. It shows the commands, asks `y/N`, then runs `ng update` for Angular/Material, `npm uninstall` for packages to remove, `npm install --save` for `dependencies` and `npm install --save-dev` for `devDependencies` (see [Automatic upgrade](#automatic-upgrade)). Preview with `--apply --dry-run`; skip the question with `--apply --yes`. Prefer to run `ng update` yourself? Use the `# by hand instead` line.
6. **Install the tool globally** (`npm install -g ngx-upgrade-doctor`). Installing it into a project with git dependencies makes npm 8 rebuild them, which can fail with `pickAlgorithm` — see [Troubleshooting installs](#troubleshooting-installs).

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
| @angular/flex-layout | **replace** → CSS flex/grid + @angular/cdk/layout | Deprecated, no releases past 15. |

Library versions are the tool's built-in best guess; confirm them for your exact versions with `ngx-upgrade-doctor deps --target 15 --online`, which reads each package's `peerDependencies` on npm.

</details>

<details>
<summary><b>15 → 16</b> · Node 16.14 / 18.10 · TypeScript 4.9–5.1 · <i>ngcc removed</i></summary>

```bash
ngx-upgrade-doctor scan --target 16
ngx-upgrade-doctor deps --target 16 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@16 @angular/cli@16 @angular/material@16
```

- **Blockers:** `ngcc` in `postinstall` (auto-fix), any library still built for View Engine.
- **By hand:** finish the Material MDC migration on this version — legacy components are gone in 17.

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

- **Tool catches:** `HttpClientModule` — replace with `provideHttpClient(withInterceptorsFromDi())`; in tests `provideHttpClientTesting()`.

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

- **By hand:** components are standalone by default now; `ng update` adds `standalone: false` to the ones still declared in an NgModule. Migrate with `ng generate @angular/core:standalone` when ready.

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
- **By hand:** Node 18 is no longer supported — `nvm use 20` or newer.

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

- **Tool catches:** `@angular/animations` (now a warning), and suggests zoneless change detection and Vitest — both are defaults for new apps only; existing apps keep zone.js and Karma until you choose to move.

**Dependencies for v21**

| Package | Version | Note |
|---|---|---|
| Node.js | ^20.19.0 or ^22.12.0 or ^24.0.0 | Runtime for `ng`; switch with nvm |
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
<summary><b>21 → 22</b> · Node 22.12 / 24 · TypeScript 5.9–6.0 (verify on angular.dev)</summary>

```bash
ngx-upgrade-doctor scan --target 22
ngx-upgrade-doctor deps --target 22 --online --apply   # ng update + npm install --save / --save-dev
# by hand instead: npx ng update @angular/core@22 @angular/cli@22
ngx-upgrade-doctor types --dry-run
ngx-upgrade-doctor types
ngx-upgrade-doctor strict          # strict-mode errors left after the types pass
```

- **Tool catches:** version requirements, and after the update offers to add explicit types (see [Explicit types](#explicit-types-v22)), then to fix the strict-mode errors that remain (see [Strict-mode errors](#strict-mode-errors)). Do each as a separate commit.
- **By hand:** read the v22 release notes; this tool's v22 Node/TypeScript ranges are marked to verify against [angular.dev/reference/versions](https://angular.dev/reference/versions).

**Dependencies for v22**

| Package | Version | Note |
|---|---|---|
| Node.js | ^22.12.0 or ^24.0.0 | Runtime for `ng`; switch with nvm |
| typescript | `>=5.9.0 <6.1.0` | `ng update` usually bumps it |
| rxjs | `^7.4.0` | RxJS 7 needs rxjs-compat gone first |
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

## Commands

| Command | When | What it does |
|---|---|---|
| `scan --target <N>` | before `ng update` | Blockers (break on N), warnings (deprecated on N) and suggestions. Exits 1 on blockers. |
| `fix --target <N>` | before `ng update` | Applies auto-fixes; lists the ones deferred until N is installed. |
| `current` | any time, no upgrade | Warnings and errors for the installed version only. |
| `deps --target <N>` | before `ng update` | Per package: `ng update`, upgrade (with version), remove or replace, plus the commands in order. |
| `plan [--target 22]` | once, at the start | Every hop with its Node and TypeScript requirements and commands. |
| `types` | on v22+ | Adds explicit types to variables, parameters, properties and return types. |
| `strict` | after `types`, or any time with `strict: true` | Fixes TS2564, TS2322 (`null`/`undefined`), TS7053, TS7015 and TS7016 compiler errors. |
| `rules` | any time | Lists every rule with its version range. |

### Options

| Option | Commands | Meaning |
|---|---|---|
| `--project <dir>` | all | Workspace root (default: current folder) |
| `--dry-run` | `fix`, `current --fix`, `types`, `strict`, `deps --apply` | Show what would change, write nothing |
| `--json` | `scan`, `current`, `deps` | Machine-readable output |
| `--verbose` | all | Show every finding |
| `--fix` / `--tsc` / `--all` | `current` | Apply fixes / add TypeScript errors / include suggestions |
| `--online` | `deps` | Resolve versions from the npm registry |
| `--latest` | `deps --online` | Suggest the newest compatible release instead of the smallest upgrade |
| `--apply`, `--yes`, `--allow-dirty`, `--ng-force`, `--legacy-peer-deps` | `deps` | Run the upgrade commands — see [Automatic upgrade](#automatic-upgrade) |
| `--mode`, `--yes`, `--no-specs`, `--skip-callbacks`, `--force` | `types` | See [Explicit types](#explicit-types-v22) |
| `--yes`, `--no-specs` | `strict` | See [Strict-mode errors](#strict-mode-errors) |

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
| `ng update` says the repository is not clean | `ng update` needs committed changes | Commit first, or add `--allow-dirty`. |
| `ng update` reports incompatible peer dependencies | A library has no release for the new Angular yet | Check that library in the `deps --online` table; `--ng-force` only if you accept the risk. |

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
| `implicit-any` | `: any` only where `noImplicitAny` reports an error — the smallest change. |

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
| TS2564 property has no initializer | `bankarray: any[];` | `bankarray!: any[];` — it is assigned later (ngOnInit, a subscribe, @Input) |
| TS2322 `null`/`undefined` not assignable | `this.otp = undefined;` · `webcamImage: WebcamImage = null;` | `this.otp = undefined as any;` · `= null as any;` |
| TS7053 dynamic key on a class | ``this[`score${i}`] = e;`` · `this[field] = '';` | ``(this as any)[`score${i}`] = e;`` |
| TS7015 string index on a non-object | `this.banking['cin']` | `(this.banking as any)['cin']` |
| TS7016 package without types | `import * as CryptoJS from 'crypto-js';` | adds `declare module 'crypto-js';` to `src/typings.d.ts` (or a new `src/untyped-modules.d.ts`) and prints `npm install --save-dev @types/crypto-js` — the better fix where it exists |

Like the types pass, every file is recompiled before it is written; a file that would gain errors is skipped and listed. Errors the tool does not fix (for example `Object is possibly 'undefined'`, TS18048) are listed at the end so you can fix them by hand. Template errors only show in `ng build`, so run it afterwards.

These fixes keep the build green; they are not good types. Over time, replace `!` with a real initial value (`bankarray: any[] = [];`), `as any` with `T | null`, and `(this as any)[key]` with a typed map such as `scores: Record<string, string> = {}`.

## Use in CI

```yaml
- run: npm ci                                   # installs ngx-upgrade-doctor from devDependencies
- run: npx ngx-upgrade-doctor scan --target 18
```

The step fails while blockers remain. Use `--json` to feed the results into other tools.

## Programmatic API

```ts
import { Project, scan, fix, adviseDeps, planTypes, planStrictFixes } from 'ngx-upgrade-doctor';

const project = new Project(process.cwd());
const results = scan({ project, mode: 'target', target: 12 });
const advice = await adviseDeps({ project, target: 12, online: true });
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

## Notes

- Version requirements live in `src/versions.ts`. The v22 entry is marked to verify; confirm it at [angular.dev/reference/versions](https://angular.dev/reference/versions).
- Old hops need old Node versions (Angular 7 needs Node 8 or 10). Use [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows) to switch per hop.
- Always commit before `fix`, and review the diff.

## License

MIT
