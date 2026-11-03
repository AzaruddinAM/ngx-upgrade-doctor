const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('../dist');

function copyFixture(name) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `nud-${name}-`));
  fs.cpSync(path.join(__dirname, 'fixtures', name), dest, { recursive: true });
  return dest;
}

const ids = (results) => results.map((r) => r.rule.id);
const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');

test('scan --target 8 reports the v7-8 blockers', () => {
  const project = new doctor.Project(copyFixture('ng6-app'));
  const results = doctor.scan({ project, mode: 'target', target: 8 });
  assert.strictEqual(results.find((r) => r.rule.id === 'core/angular-http').severity, 'error');
  assert.ok(ids(results).includes('rxjs/deep-imports'));
  assert.ok(ids(results).includes('router/string-load-children'));
  assert.ok(!ids(results).includes('material/legacy-theming-api'), 'v12 rule must not fire for target 8');
});

test('scan --target 12 flags node-sass, tslint and Material theming', () => {
  const project = new doctor.Project(copyFixture('ng6-app'));
  const results = doctor.scan({ project, mode: 'target', target: 12 });
  assert.strictEqual(results.find((r) => r.rule.id === 'build/node-sass').severity, 'error');
  assert.ok(ids(results).includes('lint/tslint'));
  assert.ok(ids(results).includes('material/legacy-theming-api'));
});

test('fix --target 8 rewrites rxjs imports and defers fixes that need a newer Angular', () => {
  const root = copyFixture('ng6-app');
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 8 });
  assert.ok(res.applied.includes('rxjs/deep-imports'));
  const svc = read(root, 'src/app/customers/customer.service.ts');
  assert.match(svc, /import \{ Observable \} from 'rxjs';/);
  assert.match(svc, /import \{ from as fromPromise \} from 'rxjs';/);
  assert.match(svc, /import \{ map \} from 'rxjs\/operators';/);
  assert.doesNotMatch(svc, /rxjs\/add\/operator\/catch/, 'a patch import nothing in the file calls is removed');
  // Installed version is 6: these fixes only compile once Angular 8 is installed.
  assert.ok(res.deferred.some((d) => d.rule.id === 'polyfills/core-js-es7'));
  assert.match(read(root, 'src/app/app-routing.module.ts'), /'\.\/customers\/customers\.module#CustomersModule'/);
});

test('current --fix applies everything the installed version supports', () => {
  const root = copyFixture('ng6-app');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['@angular/core'] = '^12.0.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  const res = doctor.fix({ project: new doctor.Project(root), mode: 'current' });
  for (const id of ['router/string-load-children', 'ivy/entry-components', 'testing/testbed-get',
    'core/module-with-providers-generic', 'build/node-sass', 'material/legacy-theming-api',
    'testing/async-to-wait-for-async', 'polyfills/zone-dist-imports']) {
    assert.ok(res.applied.includes(id), `${id} should be applied`);
  }
  assert.match(read(root, 'src/app/app-routing.module.ts'),
    /loadChildren: \(\) => import\('\.\/customers\/customers\.module'\)\.then\(m => m\.CustomersModule\)/);
  const shared = read(root, 'src/app/shared/shared.module.ts');
  assert.doesNotMatch(shared, /entryComponents/);
  assert.match(shared, /ModuleWithProviders<SharedModule>/);
  const spec = read(root, 'src/app/customers/customer.service.spec.ts');
  assert.match(spec, /import \{ TestBed, waitForAsync \}/);
  assert.match(spec, /beforeEach\(waitForAsync\(\(\) =>/);
  assert.match(spec, /it\('creates', async \(\) =>/, 'the async keyword must not be touched');
  assert.match(spec, /TestBed\.inject\(CustomerService\)/);
  const newPkg = JSON.parse(read(root, 'package.json'));
  assert.ok(!newPkg.devDependencies['node-sass']);
  assert.ok(newPkg.devDependencies.sass);
  assert.match(newPkg.scripts.postinstall, /ngcc/, 'ngcc stays until it is deprecated (v13)');
  const theme = read(root, 'src/theme.scss');
  assert.match(theme, /^@use '@angular\/material' as mat;/);
  assert.match(theme, /@include mat\.core\(\);/);
  assert.match(theme, /mat\.define-palette\(mat\.\$indigo-palette\)/);
  assert.match(theme, /mat\.define-light-theme\(/);
  assert.match(theme, /@include mat\.all-component-themes\(\$app-theme\)/);
  assert.match(theme, /@include mat\.button-theme\(\$app-theme\)/);
  assert.match(theme, /mat\.get-color-from-palette\(\$app-primary\)/);
  assert.doesNotMatch(theme, /material\/theming/);
  assert.match(read(root, 'src/polyfills.ts'), /import 'zone\.js';/);
  assert.doesNotMatch(read(root, 'tsconfig.json'), /enableIvy/);
});

test('dry run writes nothing', () => {
  const root = copyFixture('ng6-app');
  const before = read(root, 'src/app/customers/customer.service.ts');
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 8, dryRun: true });
  assert.ok(res.changedFiles.length > 0);
  assert.strictEqual(read(root, 'src/app/customers/customer.service.ts'), before);
});

test('legacy Material imports map to MDC imports', () => {
  const out = doctor.migrateLegacyMaterialTs(
    "import { MatLegacyButtonModule as MatButtonModule } from '@angular/material/legacy-button';\n"
    + "import { MatLegacyDialog } from '@angular/material/legacy-dialog';");
  assert.strictEqual(out,
    "import { MatButtonModule } from '@angular/material/button';\n"
    + "import { MatDialog } from '@angular/material/dialog';");
});

test('deps suggests versions, removals and the ng update command', async () => {
  const project = new doctor.Project(copyFixture('ng6-app'));
  const advice = await doctor.adviseDeps({ project, target: 12 });
  const by = (n) => advice.find((a) => a.name === n);
  assert.strictEqual(by('@angular/http').action, 'remove');
  assert.strictEqual(by('node-sass').action, 'replace');
  assert.strictEqual(by('@ng-bootstrap/ng-bootstrap').suggested, '^10.0.0');
  assert.strictEqual(by('@angular/core').action, 'ng-update');
  const cmds = doctor.commandsFor(advice, project, 12);
  assert.match(cmds.find((x) => /ng update/.test(x)), /ng update @angular\/core@12 @angular\/cli@12 @angular\/material@12/);
});

test('pickVersion uses peerDependencies from the registry document', () => {
  const doc = { versions: {
    '1.0.0': { peerDependencies: { '@angular/core': '^8.0.0' } },
    '2.0.0': { peerDependencies: { '@angular/core': '>=9.0.0 <12.0.0' } },
    '2.1.0': { peerDependencies: { '@angular/core': '>=9.0.0 <12.0.0' }, deprecated: 'broken' },
    '3.0.0-beta.1': { peerDependencies: { '@angular/core': '^12.0.0' } },
  } };
  assert.deepStrictEqual(doctor.pickVersion(doc, 10), { version: '2.0.0', peer: '>=9.0.0 <12.0.0', newest: '2.0.0' });
  assert.deepStrictEqual(doctor.pickVersion(doc, 13), {});
  assert.strictEqual(doctor.pickVersion({ versions: { '1.0.0': {} } }, 13), undefined);
});

test('types --mode infer adds inferred types and keeps the file compiling', () => {
  const root = copyFixture('ng22-app');
  const project = new doctor.Project(root);
  const plan = doctor.planTypes(project, { mode: 'infer' });
  assert.deepStrictEqual(plan.reverted, []);
  doctor.applyTypePlan(project, plan);
  project.flush(false);
  const out = read(root, 'src/app/user-store.ts');
  assert.match(out, /users: User\[\] = \[\] as User\[\];/);
  assert.match(out, /count: number = 0;/);
  assert.match(out, /readonly label: string = 'users';/);
  assert.match(out, /private cache: any;/);
  assert.match(out, /add\(user: any, notify\?: any\): number \{/);
  assert.match(out, /names\(\): string\[\] \{/);
  assert.match(out, /map\(\(u: User\): string => u\.name\)/);
  assert.match(out, /find\(id: number\): User \{/);
  assert.match(out, /total\(\.\.\.values: any\[\]\): number \{/);
  assert.match(out, /find\(\(u: User\): boolean => u\.id === id\)/);
  assert.match(out, /let sum: number = 0;/);
  assert.match(out, /for \(const v of values\)/, 'for-of variables cannot be annotated');
  assert.match(out, /double = \(x: any\): number => x \* 2;/);
});

test('types --mode any annotates everything with any', () => {
  const root = copyFixture('ng22-app');
  const project = new doctor.Project(root);
  doctor.applyTypePlan(project, doctor.planTypes(project, { mode: 'any' }));
  project.flush(false);
  const out = read(root, 'src/app/user-store.ts');
  assert.match(out, /count: any = 0;/);
  assert.match(out, /names\(\): any \{/);
  assert.match(out, /double = \(x: any\): any => x \* 2;/);
});

test('types --mode implicit-any only touches what noImplicitAny reports', () => {
  const root = copyFixture('ng22-app');
  const project = new doctor.Project(root);
  doctor.applyTypePlan(project, doctor.planTypes(project, { mode: 'implicit-any' }));
  project.flush(false);
  const out = read(root, 'src/app/user-store.ts');
  assert.match(out, /add\(user: any, notify\?: any\) \{/);
  assert.match(out, /count = 0;/, 'already-inferred declarations stay as they are');
  assert.match(out, /double = \(x: any\) => x \* 2;/);
});

test('at v22 the scan suggests explicit types', () => {
  const project = new doctor.Project(copyFixture('ng22-app'));
  assert.ok(ids(doctor.scan({ project, mode: 'current' })).includes('types/explicit-types'));
});

test('deps plan splits installs into --save and --save-dev and keeps packages still in use', async () => {
  const project = new doctor.Project(copyFixture('ng6-app'));
  const advice = await doctor.adviseDeps({ project, target: 12 });
  const steps = doctor.planDepCommands(advice, project, 12, { allowDirty: true });
  const of = (step) => steps.filter((s) => s.step === step);
  assert.deepStrictEqual(steps.slice(0, 2).map((s) => s.step), ['uninstall', 'ng-update'], 'removals run before ng update');
  // Angular libraries that need a bump ride along in ng update, so their old peer ranges cannot block it.
  assert.match(steps[1].command,
    /^npx ng update @angular\/core@12 @angular\/cli@12 @angular\/material@12 "@ng-bootstrap\/ng-bootstrap@\^10\.0\.0" "ngx-toastr@\^14\.3\.0" --allow-dirty$/);
  const save = of('install-save')[0].command;
  assert.strictEqual(save, 'npm install --save "rxjs@^6.5.3 || ^7.0.0" "zone.js@~0.11.4"');
  assert.doesNotMatch(save, /ng-bootstrap|ngx-toastr|typescript|sass/);
  const dev = of('install-save-dev')[0].command;
  assert.match(dev, /^npm install --save-dev /);
  assert.match(dev, /"sass@\^1\.32\.0"/);
  assert.match(dev, /"typescript@>=4\.2\.3 <4\.4\.0"/);
  assert.match(of('uninstall')[0].command, /^npm uninstall node-sass$/);
  const manual = of('manual').map((s) => s.command).join('\n');
  assert.match(manual, /Kept @angular\/http: still used in 1 file/);
  assert.match(manual, /Kept rxjs-compat: still used/);
  assert.match(manual, /tslint:/);
  assert.match(manual, /protractor:/);
  // commandsFor keeps returning only the runnable commands.
  assert.deepStrictEqual(doctor.commandsFor(advice, project, 12, { allowDirty: true }), steps.filter((s) => s.step !== 'manual').map((s) => s.command));
});

test('pickVersion prefers the smallest upgrade over the newest compatible release', () => {
  const peer = { peerDependencies: { '@angular/core': '>=13.0.0' } };
  const doc = { versions: { '13.0.0': peer, '13.2.0': peer, '14.1.0': peer, '15.0.3': peer, '18.1.7': peer, '12.0.0': { peerDependencies: { '@angular/core': '^12.0.0' } } } };
  assert.deepStrictEqual(doctor.pickVersion(doc, 15, '13.0.0'), { version: '13.2.0', peer: '>=13.0.0', newest: '18.1.7' });
  assert.deepStrictEqual(doctor.pickVersion(doc, 15, '^12.0.0'), { version: '13.2.0', peer: '>=13.0.0', newest: '18.1.7' });
  assert.strictEqual(doctor.pickVersion(doc, 15, '13.0.0', true).version, '18.1.7', '--latest');
  assert.strictEqual(doctor.pickVersion(doc, 15).version, '18.1.7', 'no current version known');
});

test('packages with no compatible release are never uninstalled', () => {
  const project = new doctor.Project(copyFixture('ng6-app'));
  const advice = [
    { name: 'angular2-signaturepad', current: '2.11.0', action: 'replace', source: 'npm-registry', note: 'No published version declares support for Angular 15.' },
    { name: 'ngx-abandoned', current: '14.0.0', action: 'replace', suggested: 'CSS flex/grid', source: 'rule', note: 'Deprecated.' },
  ];
  const steps = doctor.planDepCommands(advice, project, 15);
  assert.ok(!steps.some((s) => s.step === 'uninstall'));
  assert.strictEqual(steps.filter((s) => s.step === 'manual' && s.command !== doctor.CLEAR_CACHE).length, 2);
});

test('gitDependencies finds git specs in package.json and package-lock.json', () => {
  const root = copyFixture('ng6-app');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['ngx-xml2json'] = 'github:someone/ngx-xml2json#v1.0.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': {}, 'node_modules/signature_pad': { resolved: 'git+ssh://git@github.com/szimek/signature_pad.git#abc' },
    'node_modules/rxjs': { resolved: 'https://registry.npmjs.org/rxjs/-/rxjs-6.2.0.tgz' },
  } }));
  const found = doctor.gitDependencies(new doctor.Project(root));
  assert.deepStrictEqual(found.map((g) => [g.name, g.direct]), [['ngx-xml2json', true], ['signature_pad', false]]);
});

test('deps --online never suggests a downgrade', async () => {
  const peer = (r) => ({ peerDependencies: { '@angular/core': r } });
  const doc = { versions: { '6.0.2': peer('>=5.0.0'), '9.0.0': peer('^12.0.0'), '10.0.0': peer('^16.0.0') } };
  assert.strictEqual(doctor.pickVersion(doc, 15, '9.0.0').version, '6.0.2', 'pickVersion itself reports the newest compatible');
  const project = new doctor.Project(copyFixture('ng6-app'));
  const advice = [{ name: 'ng2-pdf-viewer', current: '9.0.0', action: 'check', source: 'npm-registry', note: 'x' }];
  const steps = doctor.planDepCommands(advice, project, 15);
  assert.ok(!steps.some((s) => /ng2-pdf-viewer/.test(s.command) && s.step !== 'manual'));
});

test('strict fixes TS2564, TS2322 null/undefined, TS7053/TS7015 and TS7016 without other changes', () => {
  const root = copyFixture('ng22-strict');
  fs.mkdirSync(path.join(root, 'node_modules/crypto-js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/crypto-js/package.json'), '{"name":"crypto-js","version":"4.2.0","main":"index.js"}');
  fs.writeFileSync(path.join(root, 'node_modules/crypto-js/index.js'), 'module.exports = {};');
  const project = new doctor.Project(root);
  const plan = doctor.planStrictFixes(project);
  assert.deepStrictEqual(plan.remaining, []);
  assert.deepStrictEqual(plan.reverted, []);
  assert.deepStrictEqual(plan.modules, ['crypto-js']);
  doctor.applyStrictPlan(project, plan);
  project.flush(false);
  const src = read(root, 'src/app/score.component.ts');
  assert.match(src, /bankarray!: any\[\];/);
  assert.match(src, /private _value!: string;/);
  assert.match(src, /optional\?: string;/, 'optional properties are left alone');
  assert.match(src, /webcamImage: TableSource<any> = null as any;/);
  assert.match(src, /this\.otp = this\.password = undefined as any;/);
  assert.match(src, /\(this as any\)\[`score\$\{k - 1 \|\| ''\}`\] = e;/);
  assert.match(src, /Number\(\(this as any\)\[key\]\)/);
  assert.match(src, /\(this\.banking as any\)\['cin'\]/);
  assert.match(src, /\(this\.panelClass as any\)\[panel\] = true;/);
  assert.strictEqual(read(root, 'src/untyped-modules.d.ts'), "declare module 'crypto-js';\n");
  assert.strictEqual(doctor.planStrictFixes(new doctor.Project(root)).fixes.length, 0, 'a second run finds nothing');
});

test('scan --target 16 flags imports of packages missing from package.json', () => {
  const project = new doctor.Project(copyFixture('ng16-app'));
  const results = doctor.scan({ project, mode: 'target', target: 16, only: ['deps/missing-packages'] });
  assert.strictEqual(results[0].severity, 'error');
  const msgs = results[0].findings.map((f) => f.message).join('\n');
  for (const pkg of ['@zxing/ngx-scanner', 'angular-cropperjs', 'ngx-xml2json', 'rxjs-compat']) {
    assert.match(msgs, new RegExp(`package ${pkg} is not in package\.json`));
  }
  assert.doesNotMatch(msgs, /@env|app\/shared|'fs'|@angular\/material|'rxjs['/]/, 'aliases, builtins and declared packages resolve');
  assert.strictEqual(results[0].findings.length, 4);
  assert.doesNotMatch(msgs, /angular2-signaturepad|intl|ng2-image-viewer|not-an-import/, 'commented-out imports and strings are ignored');
  assert.strictEqual(results[1].severity, 'warning');
  assert.deepStrictEqual(results[1].findings.map((f) => [f.file, f.line]), [['e2e/app.po.ts', 1]]);
  assert.match(results[1].findings[0].message, /protractor .*not part of the app build/);
  assert.strictEqual(doctor.packageOf('@angular/common/http'), '@angular/common');
  assert.strictEqual(doctor.packageOf('rxjs/add/operator/map'), 'rxjs');
  assert.strictEqual(doctor.packageOf('./x'), undefined);
  assert.strictEqual(doctor.packageOf('node:path'), undefined);
});

test('RxJS 5 patch imports are errors when rxjs-compat is not installed', () => {
  const root = copyFixture('ng16-app');
  const results = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 16 });
  const compat = results.find((r) => r.rule.id === 'rxjs/compat-imports-without-package');
  assert.strictEqual(compat.severity, 'error');
  const msgs = compat.findings.map((f) => f.message);
  assert.deepStrictEqual(msgs.map((m) => m.split("'")[1]),
    ['rxjs/Rx', 'rxjs/add/operator/map', 'rxjs/add/observable/of', 'rxjs-compat/operator/find']);
  assert.ok(results.find((r) => r.rule.id === 'rxjs/deep-imports').findings.some((f) => /rxjs-compat\/operator\/find/.test(f.message)));

  // With rxjs-compat declared (RxJS 6), the imports still compile.
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['rxjs-compat'] = '^6.6.7';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const again = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 16 });
  assert.ok(!ids(again).includes('rxjs/compat-imports-without-package'));
});

test('known-incompatible libraries are flagged by scan and deps', async () => {
  const project = new doctor.Project(copyFixture('ng16-app'));
  const rule = doctor.scan({ project, mode: 'target', target: 16 }).find((r) => r.rule.id === 'deps/known-incompatible');
  assert.strictEqual(rule.severity, 'error');
  assert.deepStrictEqual(rule.findings.map((f) => f.message.split('@')[0]).sort(),
    ['ng2-pdf-viewer', 'ngx-image-cropper', 'ngx-material-timepicker', 'ngx-perfect-scrollbar', 'ngx-webcam']);
  const at12 = doctor.scan({ project, mode: 'target', target: 12 });
  assert.ok(!ids(at12).includes('deps/known-incompatible'));

  const advice = await doctor.adviseDeps({ project, target: 16 });
  const by = (n) => advice.find((a) => a.name === n);
  assert.deepStrictEqual([by('ngx-perfect-scrollbar').action, by('ngx-perfect-scrollbar').suggested], ['replace', 'ngx-om-perfect-scrollbar@^16.0.0']);
  assert.strictEqual(by('ngx-material-timepicker').suggested, '^13.0.0');
  assert.strictEqual(by('ngx-webcam').suggested, '^0.4.1');
  assert.strictEqual(by('ngx-image-cropper').suggested, '^7.0.0');
  assert.strictEqual(by('ng2-pdf-viewer').suggested, '^10.0.0');
  assert.strictEqual(by('@angular/flex-layout').action, 'replace');
  assert.ok(doctor.commandsFor(advice, project, 16).some((c) => /npm install --save .*"ngx-webcam@\^0\.4\.1"/.test(c)));
  assert.strictEqual(doctor.knownBreaker('ngx-webcam', '0.4.1', 16), undefined);
  assert.strictEqual(doctor.knownBreaker('ngx-webcam', '^0.3.0', 12), undefined);
});

test('current --fix on Angular 16 removes core-js polyfills and leftover MatLegacy symbols', () => {
  const root = copyFixture('ng16-app');
  const project = new doctor.Project(root);
  const scanned = doctor.scan({ project, mode: 'current' });
  const polyfills = scanned.find((r) => r.rule.id === 'polyfills/core-js-unneeded');
  assert.strictEqual(polyfills.findings.length, 3);
  assert.match(polyfills.findings[0].message, /core-js 2\.6\.12 has no core-js\/es\/\* path/);
  const legacy = scanned.find((r) => r.rule.id === 'material/legacy-components').findings.map((f) => f.message);
  assert.ok(legacy.some((m) => /getMatLegacyAutocompleteMissingPanelError .*→ getMatAutocompleteMissingPanelError/.test(m)));
  assert.ok(legacy.some((m) => /MatLegacyButtonModule .*→ MatButtonModule/.test(m)));

  const res = doctor.fix({ project: new doctor.Project(root), mode: 'current' });
  assert.ok(res.applied.includes('polyfills/core-js-unneeded'));
  assert.ok(res.applied.includes('material/legacy-components'));
  assert.strictEqual(read(root, 'src/polyfills.ts'), "/** IE9, IE10 and IE11 requires all of the following polyfills. **/\n\nimport 'zone.js';\n");
  const cmp = read(root, 'src/app/scanner.component.ts');
  assert.match(cmp, /import \{ MatAutocompleteModule, getMatAutocompleteMissingPanelError \} from '@angular\/material\/autocomplete';/);
  assert.match(cmp, /error = getMatAutocompleteMissingPanelError\(\);/);
  assert.match(cmp, /import \{ MatButtonModule \} from '@angular\/material\/button';/);
});

test('positional palettes in define-light-theme are flagged, config maps are not', () => {
  const project = new doctor.Project(copyFixture('ng16-app'));
  const rule = doctor.scan({ project, mode: 'target', target: 16 }).find((r) => r.rule.id === 'material/theme-positional-palettes');
  assert.strictEqual(rule.severity, 'warning');
  assert.deepStrictEqual(rule.findings.map((f) => [f.file, f.line]), [['src/skins/m2-skin.scss', 7], ['src/skins/m2-skin.scss', 8], ['src/theme.scss', 7]]);
  assert.strictEqual(doctor.positionalThemeCalls('$t: mat.define-dark-theme(mat.define-palette(mat.$red-palette), $a);').length, 1);
  assert.strictEqual(doctor.positionalThemeCalls('$t: mat.define-dark-theme((color: (primary: $p, accent: $a)));').length, 0);
});

test('View Engine libraries nobody imports are warnings, imported ones are blockers', () => {
  const root = copyFixture('ng16-app');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const [name, used] of [['ngx-mask', false], ['ngx-image-cropper', true]]) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '2.0.0' }));
    fs.writeFileSync(path.join(dir, `${name}.metadata.json`), '{}');
    pkg.dependencies[name] = '2.0.0';
    if (used) fs.appendFileSync(path.join(root, 'src/app/shared/util.ts'), `import { X } from '${name}';
`);
    else fs.appendFileSync(path.join(root, 'src/app/shared/util.ts'), `// import { Y } from '${name}';
`);
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const results = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 17, only: ['ivy/view-engine-libraries'] });
  const by = (s) => results.find((r) => r.severity === s).findings.map((f) => f.message);
  assert.deepStrictEqual(by('error'), ['ngx-image-cropper@2.0.0 ships View Engine metadata (needs ngcc)']);
  assert.match(by('warning')[0], /^ngx-mask@2\.0\.0 .*unused; npm uninstall ngx-mask/);
  assert.deepStrictEqual(doctor.filesUsing(new doctor.Project(root), 'ngx-mask'), [], 'commented-out imports do not count');
});

test('TSLint is a warning, never a blocker', () => {
  const project = new doctor.Project(copyFixture('ng6-app'));
  for (const target of [12, 13, 17]) {
    const r = doctor.scan({ project, mode: 'target', target, only: ['lint/tslint'] });
    assert.deepStrictEqual(r.map((x) => x.severity), ['warning'], `target ${target}`);
  }
});

test('Node version message names unsupported majors and nvm-installed versions', () => {
  const nvm = fs.mkdtempSync(path.join(os.tmpdir(), 'nud-nvm-'));
  for (const v of ['v18.20.4', 'v20.11.1', 'v22.1.0', 'settings.txt']) fs.mkdirSync(path.join(nvm, v));
  const unixHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nud-home-'));
  fs.mkdirSync(path.join(unixHome, '.nvm', 'versions', 'node', 'v20.9.0'), { recursive: true });
  const installed = doctor.nvmInstalledVersions({ NVM_HOME: nvm }, unixHome);
  assert.deepStrictEqual(installed, ['22.1.0', '20.11.1', '20.9.0', '18.20.4']);

  const msg = doctor.nodeVersionMessage('22.1.0', '^18.13.0 || ^20.9.0', 17, installed);
  assert.ok(msg.includes('Supported: Node 18 (>=18.13.0), 20 (>=20.9.0); Node 21+ is not supported.'), msg);
  assert.ok(msg.endsWith('Installed with nvm and compatible: 20.11.1, 20.9.0, 18.20.4 — nvm use 20.11.1; or install the latest Node 20.x (nvm install 20), which current tooling may need.'), msg);
  assert.ok(doctor.nodeVersionMessage('22.1.0', '^18.13.0 || ^20.9.0', 17, []).endsWith('Suggested: the latest Node 20.x (nvm install 20).'));
  assert.strictEqual(doctor.suggestedNode('^20.19.0 || ^22.12.0 || ^24.0.0').text, 'the latest Node 24.x (nvm install 24)');
  assert.ok(doctor.nodeVersionMessage('22.1.0', '^18.13.0 || ^20.9.0', 17, ['22.1.0']).includes('(none of the nvm-installed 22.1.0 fit)'));
});

test('fix reports rules whose fix changed nothing, and rewrites public rxjs/internal imports', () => {
  const root = copyFixture('ng16-app');
  let res = doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/deep-imports'] });
  assert.deepStrictEqual(res.applied, [], 'only manual rxjs findings: nothing is "applied"');
  assert.deepStrictEqual(res.unchanged, [], 'a rule with no fixable findings is not even run');
  assert.deepStrictEqual(res.changedFiles, []);
  const noop = { id: 'test/noop', hop: 'x', title: 'x', since: 6, level: 'warning', check: () => [{ message: 'x' }], fix: () => undefined };
  res = doctor.fix({ project: new doctor.Project(root), mode: 'current', rules: [noop] });
  assert.deepStrictEqual([res.applied, res.unchanged], [[], ['test/noop']]);

  fs.writeFileSync(path.join(root, 'src/app/repayment.service.ts'), [
    "import { BehaviorSubject } from 'rxjs/internal/BehaviorSubject';",
    "import { map as mapTo2 } from 'rxjs/internal/operators/map';",
    "import { subscribeToResult } from 'rxjs/internal/util/subscribeToResult';",
    '',
  ].join('\n'));
  const scanned = doctor.scan({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/deep-imports'] })[0].findings
    .filter((f) => f.file === 'src/app/repayment.service.ts').map((f) => f.message);
  assert.deepStrictEqual(scanned, [
    "Deep import 'rxjs/internal/BehaviorSubject' (auto-fixable)",
    "Deep import 'rxjs/internal/operators/map' (auto-fixable)",
    "Deep import 'rxjs/internal/util/subscribeToResult' (manual)",
  ]);
  res = doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/deep-imports'] });
  assert.deepStrictEqual(res.applied, ['rxjs/deep-imports']);
  assert.deepStrictEqual(res.changedFiles, ['src/app/repayment.service.ts']);
  assert.strictEqual(read(root, 'src/app/repayment.service.ts'), [
    "import { BehaviorSubject } from 'rxjs';",
    "import { map as mapTo2 } from 'rxjs/operators';",
    "import { subscribeToResult } from 'rxjs/internal/util/subscribeToResult';",
    '',
  ].join('\n'));
  assert.strictEqual(doctor.rewriteRxjsImport(' async ', 'rxjs/internal/scheduler/async'), "import { asyncScheduler as async } from 'rxjs';");
  assert.strictEqual(doctor.rewriteRxjsImport(' Observable, isFunction ', 'rxjs/internal/Observable'), undefined, 'one non-public symbol keeps the whole import manual');
});

function installPackage(root, name, pkgJson, files = {}) {
  const dir = path.join(root, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...pkgJson }));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
}

test('deps --online: no or wildcard Angular peer is compatible, View Engine builds need an upgrade', async () => {
  const root = copyFixture('ng16-app');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  Object.assign(pkg.dependencies, {
    'ng2-pdf-viewer': '^10.0.0', 'ngx-image-compress': '^13.1.0', 'ngx-mask': '^7.9.10', 'ngx-unused-ve': '^1.0.0',
  });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  installPackage(root, 'ng2-pdf-viewer', { version: '10.0.0', peerDependencies: { 'pdfjs-dist': '~2.16.105' } });
  installPackage(root, 'ngx-image-compress', { version: '13.1.0', peerDependencies: { '@angular/core': 'x.x.x' } });
  installPackage(root, 'ngx-mask', { version: '7.9.10', peerDependencies: { '@angular/core': '>=6.0.0' } }, { 'ngx-mask.metadata.json': '{}' });
  installPackage(root, 'ngx-unused-ve', { version: '1.0.0' }, { 'index.metadata.json': '{}' });
  fs.appendFileSync(path.join(root, 'src/app/shared/util.ts'), "import { NgxMaskModule } from 'ngx-mask';\n");

  const peer = (r) => ({ peerDependencies: { '@angular/core': r } });
  const docs = {
    'ng2-pdf-viewer': { versions: { '6.0.2': peer('>=5.0.0'), '10.0.0': { peerDependencies: { 'pdfjs-dist': '~2.16.105' } } } },
    'ngx-image-compress': { versions: { '9.0.0': peer('^9.0.0'), '13.1.0': peer('x.x.x') } },
    'ngx-mask': { versions: { '7.9.10': peer('>=6.0.0'), '16.0.0': peer('>=16.0.0'), '17.0.0': peer('>=17.0.0') } },
  };
  const server = require('http').createServer((req, res) => {
    const doc = docs[decodeURIComponent(req.url.slice(1))];
    res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
    res.end(doc ? JSON.stringify(doc) : '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const project = new doctor.Project(root);
    const offline = await doctor.adviseDeps({ project, target: 17 });
    const off = (n) => offline.find((a) => a.name === n);
    assert.strictEqual(off('ngx-mask').action, 'upgrade');
    assert.ok(off('ngx-mask').viewEngine);
    assert.strictEqual(off('ngx-unused-ve').action, 'remove');
    assert.match(off('ngx-image-compress').note, /unconstrained @angular\/core peer \(x\.x\.x\)/);

    const advice = await doctor.adviseDeps({ project, target: 17, online: true, registry: `http://127.0.0.1:${server.address().port}` });
    const by = (n) => advice.find((a) => a.name === n);
    assert.strictEqual(by('ng2-pdf-viewer').action, 'ok');
    assert.match(by('ng2-pdf-viewer').note, /declares no @angular\/core peer/);
    assert.doesNotMatch(by('ng2-pdf-viewer').note, /6\.0\.2/);
    assert.strictEqual(by('ngx-image-compress').action, 'ok');
    assert.deepStrictEqual([by('ngx-mask').action, by('ngx-mask').suggested], ['upgrade', '^17.0.0']);
    assert.match(by('ngx-mask').note, /View Engine/);
    const cmds = doctor.commandsFor(advice, project, 17);
    assert.ok(cmds.some((c) => /npm uninstall .*ngx-unused-ve/.test(c)));
    assert.ok(cmds.some((c) => /"ngx-mask@\^17\.0\.0"/.test(c)));
  } finally {
    server.close();
  }
  assert.deepStrictEqual(doctor.angularPeer(peer('x.x.x')), { wildcard: 'x.x.x' });
  assert.deepStrictEqual(doctor.angularPeer(peer('*')), { wildcard: '*' });
  assert.deepStrictEqual(doctor.angularPeer(peer('>=16.0.0')), { peer: '>=16.0.0' });
  assert.deepStrictEqual(doctor.pickVersion(docs['ngx-image-compress'], 17), {}, 'a wildcard release is not "compatible"');
});

test('deps plan: Angular-peer upgrades join ng update, flags show up in the printed commands', () => {
  const root = copyFixture('ng16-app');
  installPackage(root, 'angular-in-memory-web-api', { version: '0.15.0', peerDependencies: { '@angular/core': '^15.0.0' } });
  installPackage(root, 'lodash-es', { version: '4.17.0' });
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  Object.assign(pkg.dependencies, { 'angular-in-memory-web-api': '~0.15.0', 'lodash-es': '^4.17.0' });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const project = new doctor.Project(root);
  const advice = [
    { name: 'angular-in-memory-web-api', current: '0.15.0', action: 'upgrade', suggested: '^0.17.0', source: 'npm-registry', note: '' },
    { name: 'lodash-es', current: '4.17.0', action: 'upgrade', suggested: '^4.17.21', source: 'npm-registry', note: '' },
    { name: 'ngx-unused', current: '1.0.0', action: 'remove', source: 'installed-peer', note: '' },
  ];
  const steps = doctor.planDepCommands(advice, project, 17, { legacyPeerDeps: true, ngForce: true, allowDirty: true });
  assert.deepStrictEqual(steps.filter((s) => s.step !== 'manual').map(doctor.displayCommand), [
    'npm uninstall ngx-unused --legacy-peer-deps',
    'npm_config_legacy_peer_deps=true npx ng update @angular/core@17 @angular/cli@17 @angular/material@17 "angular-in-memory-web-api@^0.17.0" --allow-dirty --force',
    'npm install --save "lodash-es@^4.17.21" --legacy-peer-deps',
  ], 'removals first, then ng update (with Angular-peer bumps), then plain installs');
  const plain = doctor.planDepCommands(advice, project, 17);
  assert.ok(plain.every((s) => !/legacy-peer-deps/.test(doctor.displayCommand(s))));
});

test('--tsc type-checks with the project TypeScript, falling back to the bundled one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nud-ts-'));
  assert.strictEqual(doctor.projectTypeScript(root).bundled, true);
  installPackage(root, 'typescript', { version: '5.4.5', main: 'index.js' }, { 'index.js': "module.exports = { version: '5.4.5' };" });
  const info = doctor.projectTypeScript(root);
  assert.deepStrictEqual([info.bundled, info.version, info.ts.version], [false, '5.4.5', '5.4.5']);
});

test('theme rule covers m2-define-* with any namespace and rewrites positional calls to a map', () => {
  const root = copyFixture('ng16-app');
  const project = new doctor.Project(root);
  const rule = doctor.scan({ project, mode: 'target', target: 18, only: ['material/theme-positional-palettes'] })[0];
  assert.match(rule.findings[0].message, /^m\.m2-define-light-theme\(\) with positional palettes .*\(auto-fixable\)$/);
  assert.ok(rule.findings.every((f) => f.fixable));
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['material/theme-positional-palettes'] });
  assert.deepStrictEqual(res.applied, ['material/theme-positional-palettes']);
  const skin = read(root, 'src/skins/m2-skin.scss');
  assert.match(skin, /\$light: m\.m2-define-light-theme\(\(color: \(primary: \$p, accent: \$a, warn: \$w\), typography: m\.m2-define-typography-config\(\), density: 0\)\);/);
  assert.match(skin, /\$dark: m\.m2-define-dark-theme\(\(color: \(primary: \$p, accent: \$a\), typography: m\.m2-define-typography-config\(\), density: 0\)\);/);
  assert.match(read(root, 'src/theme.scss'),
    /mat\.define-light-theme\(\(color: \(primary: \$app-primary, accent: \$app-accent, warn: \$app-warn\), typography: mat\.define-typography-config\(\), density: 0\)\)/);
  assert.match(read(root, 'src/theme.scss'), /mat\.define-light-theme\(\$theme-config\)/, 'a single (map) argument is left alone');
  assert.strictEqual(doctor.positionalThemeCalls('$t: mat.define-light-theme($primary: $p, $accent: $a);')[0].fixable, false, 'keyword arguments are manual');
  assert.deepStrictEqual(doctor.scan({ project: new doctor.Project(root), mode: 'current', only: ['material/theme-positional-palettes'] }), []);
});

test('HttpClientModule: only metadata entries are reported, duplicates are found and removed', () => {
  const root = copyFixture('ng16-app');
  const scanned = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['http/http-client-module', 'core/duplicate-metadata-entries'] });
  const http = scanned.find((r) => r.rule.id === 'http/http-client-module').findings;
  assert.deepStrictEqual(http.map((f) => [f.file, f.line, f.message]), [
    ['src/app/app.module.ts', 8, 'HttpClientModule in @NgModule imports'],
    ['src/app/app.module.ts', 10, 'HttpClientModule in @NgModule imports'],
  ], 'not the import statement on line 2, not the comment on line 9');
  const dup = scanned.find((r) => r.rule.id === 'core/duplicate-metadata-entries');
  assert.strictEqual(dup.severity, 'warning');
  assert.deepStrictEqual(dup.findings.map((f) => [f.line, f.message]), [
    [10, 'HttpClientModule listed 2 times in @NgModule imports — the v18 HTTP migration leaves a dangling reference (auto-fixable)'],
  ]);
  const at17 = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 17, only: ['core/duplicate-metadata-entries'] });
  assert.strictEqual(at17[0].severity, 'info', 'only a warning once the v18 migration is ahead');

  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['core/duplicate-metadata-entries'] });
  assert.deepStrictEqual(res.applied, ['core/duplicate-metadata-entries']);
  assert.match(read(root, 'src/app/app.module.ts'), /imports: \[\n    HttpClientModule,\n  \],/);

  const many = doctor.duplicateMetadataEntries('x.ts',
    '@NgModule({ imports: [A, B, A, RouterModule.forChild(r), RouterModule.forChild(r), B], providers: [S, S] }) class M {}');
  assert.deepStrictEqual(many.map((d) => [d.name, d.count, d.prop]), [['A', 2, 'imports'], ['B', 2, 'imports'], ['S', 2, 'providers']]);
});

test('auto-fixable counts only fixable findings', () => {
  const project = new doctor.Project(copyFixture('ng16-app'));
  const rx = doctor.scan({ project, mode: 'target', target: 18, only: ['rxjs/deep-imports'] })[0];
  assert.ok(rx.findings.length > 0);
  assert.ok(rx.findings.every((f) => !f.fixable), 'every rxjs finding here is (manual)');
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    require('../dist/report').printFindings([rx], false);
    require('../dist/report').printSummary([rx]);
  } finally {
    console.log = log;
  }
  assert.ok(!lines.some((l) => /\[auto-fix\]/.test(l)));
  assert.match(lines[lines.length - 1], /; 0 auto-fixable$/);
});

test('v19: relative url() in template <style> blocks is a blocker, fixed with ^', () => {
  const root = copyFixture('ng16-app');
  const rule = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 19, only: ['template/style-relative-url'] })[0];
  assert.strictEqual(rule.severity, 'error');
  assert.deepStrictEqual(rule.findings.map((f) => [f.file, f.line, f.message]), [
    ['src/app/pay/pay.component.html', 3, "url(assets/img/bg.jpg) in a <style> block (file not found in the component folder or src — already broken at runtime) (auto-fixable)"],
    ['src/app/pay/pay.component.html', 4, 'url(assets/img/logo.png) in a <style> block (auto-fixable)'],
  ], 'absolute, data:, https:, ^ and # urls, and style="" attributes are fine');
  assert.ok(!doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 18 }).some((r) => r.rule.id === 'template/style-relative-url'));

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['@angular/core'] = '^19.2.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['template/style-relative-url'] });
  assert.deepStrictEqual(res.applied, ['template/style-relative-url']);
  const html = read(root, 'src/app/pay/pay.component.html');
  assert.match(html, /url\('\^assets\/img\/bg\.jpg'\)/);
  assert.match(html, /url\(\^assets\/img\/logo\.png\) no-repeat/);
  assert.match(html, /url\('\^assets\/img\/logo\.png'\), url\(#grad\)/, 'already-kept urls are not prefixed twice');
  assert.match(html, /style="background: url\(assets\/img\/inline-attr\.png\)"/);
  assert.strictEqual(doctor.keepTemplateStyleUrls(html), html, 'idempotent');
  assert.deepStrictEqual(doctor.templateStyleUrls("@Component({ template: `<style>a { background: url(img/x.png) }</style>` })").map((u) => u.url), ['img/x.png']);
});

test('v19: Sass @import and global built-ins are warnings', () => {
  const project = new doctor.Project(copyFixture('ng16-app'));
  const rule = doctor.scan({ project, mode: 'target', target: 19, only: ['sass/module-system'] })[0];
  assert.strictEqual(rule.severity, 'warning');
  const legacy = rule.findings.find((f) => f.file === 'src/app/theme/_legacy.scss');
  assert.strictEqual(legacy.message, '1 @import rule(s), 2 global built-in call(s) (map-get, darken)');
  assert.ok(!rule.findings.some((f) => f.file === 'src/skins/m2-skin.scss'), '@use and namespaced calls are fine');
  assert.match(rule.rule.hint, /sass-migrator module --migrate-deps/);
  assert.ok(!doctor.scan({ project, mode: 'target', target: 18 }).some((r) => r.rule.id === 'sass/module-system'));
});

test('plan Node line shows the range and whether the running Node fits', () => {
  assert.strictEqual(doctor.nodeFit('^18.19.1 || ^20.11.1 || ^22.0.0', '20.18.1'), 'your Node 20.18.1 fits');
  assert.strictEqual(doctor.nodeFit('^20.19.0 || ^22.12.0', '20.18.1'), 'your Node 20.18.1 does not fit');
});

test('flex-layout: runtime blocker on v19, swapped to @ngbracket/ngx-layout by fix and deps', async () => {
  const root = copyFixture('ng16-app');
  const at = (target) => doctor.scan({ project: new doctor.Project(root), mode: 'target', target, only: ['deps/flex-layout'] });
  assert.strictEqual(at(17)[0].severity, 'warning');
  const r19 = at(19)[0];
  assert.strictEqual(r19.severity, 'error');
  assert.deepStrictEqual(r19.findings.map((f) => [f.file, f.line, f.message]), [
    ['package.json', 9, '@angular/flex-layout@^15.0.0-beta.42: crashes at runtime on Angular 19+ (NgClass/NgStyle constructor changed) → @ngbracket/ngx-layout@^19.0.0 (auto-fixable)'],
    ['src/app/layout.module.ts', 2, "import from '@angular/flex-layout' → '@ngbracket/ngx-layout' (auto-fixable)"],
    ['src/app/layout.module.ts', 3, "import from '@angular/flex-layout/extended' → '@ngbracket/ngx-layout/extended' (auto-fixable)"],
  ], 'the commented-out import is ignored');

  const project = new doctor.Project(root);
  const advice = await doctor.adviseDeps({ project, target: 19 });
  assert.strictEqual(advice.find((a) => a.name === '@angular/flex-layout').suggested, '@ngbracket/ngx-layout@^19.0.0');
  const steps = doctor.planDepCommands(advice, project, 19).map((s) => s.command);
  assert.ok(steps.some((c) => /^npm uninstall .*@angular\/flex-layout/.test(c)), 'uninstalled although still imported');
  assert.ok(steps.some((c) => /^npm install --save .*"@ngbracket\/ngx-layout@\^19\.0\.0"/.test(c)));
  assert.ok(steps.includes('Then rewrite the @angular/flex-layout imports: ngx-upgrade-doctor current --fix.'));
  assert.strictEqual(steps[steps.length - 1], doctor.CLEAR_CACHE);

  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 19, only: ['deps/flex-layout'] });
  assert.deepStrictEqual(res.applied, ['deps/flex-layout']);
  const pkg = JSON.parse(read(root, 'package.json'));
  assert.ok(!pkg.dependencies['@angular/flex-layout']);
  assert.strictEqual(pkg.dependencies['@ngbracket/ngx-layout'], '^19.0.0');
  const mod = read(root, 'src/app/layout.module.ts');
  assert.match(mod, /from '@ngbracket\/ngx-layout';/);
  assert.match(mod, /from "@ngbracket\/ngx-layout\/extended";/);
  assert.match(mod, /\/\/ import \{ GridModule \} from '@ngbracket\/ngx-layout\/grid';/);
  // Leftover imports are still found once the package itself is gone from package.json.
  fs.writeFileSync(path.join(root, 'src/app/left.ts'), "import { FlexModule } from '@angular/flex-layout/flex';\n");
  assert.strictEqual(at(19)[0].findings.length, 1);
});

test('v19: libraries calling the old NgClass/NgStyle constructors are runtime blockers', () => {
  const root = copyFixture('ng16-app');
  installPackage(root, '@angular/flex-layout', { version: '15.0.0-beta.42' });
  fs.mkdirSync(path.join(root, 'node_modules/@angular/flex-layout/fesm2020'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/@angular/flex-layout/fesm2020/extended.mjs'),
    'class ClassDirective {\n  constructor(a, b, el, r) {\n    this.ngClassInstance = new NgClass(a, b, el, r);\n  }\n}\n');
  installPackage(root, 'ngx-good', { version: '1.0.0' }, { 'index.mjs': 'x = new i1.NgClass(el, renderer); y = new NgStyle(el, differs, renderer);' });
  installPackage(root, 'ngx-old-style', { version: '2.0.0' }, { 'index.js': 'y = new i0.NgStyle(differs, el, renderer, extra);' });
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  Object.assign(pkg.dependencies, { 'ngx-good': '1.0.0', 'ngx-old-style': '2.0.0' });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  const rule = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 19, only: ['deps/common-directive-constructors'] })[0];
  assert.strictEqual(rule.severity, 'error');
  assert.deepStrictEqual(rule.findings.map((f) => f.message), [
    'ngx-old-style@2.0.0: new NgStyle(…4 args) in index.js:1 — Angular 19 expects 3',
  ], 'only declared non-@angular packages are inspected');
  assert.deepStrictEqual(doctor.commonDirectiveConstructions('new NgClass(a, f(b, c), [d, e], { x: 1 })').map((c) => c.args), [4]);
  assert.deepStrictEqual(doctor.commonDirectiveConstructions('new NgClass()').map((c) => c.args), [0]);
});

test('deps --online: per-Angular-major releases beat an open-ended peer', async () => {
  const root = copyFixture('ng16-app');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete pkg.dependencies['@angular/flex-layout'];
  Object.assign(pkg.dependencies, { '@ngbracket/ngx-layout': '^19.0.0', 'ngx-open-ended': '^3.0.0' });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  installPackage(root, '@ngbracket/ngx-layout', { version: '19.0.0', peerDependencies: { '@angular/core': '>=19.0.0' } });
  installPackage(root, 'ngx-open-ended', { version: '3.0.0', peerDependencies: { '@angular/core': '>=15.0.0' } });

  const peer = (r) => ({ peerDependencies: { '@angular/core': r } });
  const docs = {
    '@ngbracket/ngx-layout': { versions: {
      '19.0.0': peer('>=19.0.0'), '20.0.0': peer('>=20.0.0'), '20.0.1': peer('>=20.0.0'), '21.0.0': peer('>=21.0.0'), '20.1.0-rc.0': peer('>=20.0.0'),
    } },
    // Only raised the floor to 18: no release made for 20, so the open-ended one stays ok.
    'ngx-open-ended': { versions: { '3.0.0': peer('>=15.0.0'), '4.0.0': peer('>=18.0.0') } },
  };
  const server = require('http').createServer((req, res) => {
    const doc = docs[decodeURIComponent(req.url.slice(1))];
    res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
    res.end(doc ? JSON.stringify(doc) : '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const project = new doctor.Project(root);
    const advice = await doctor.adviseDeps({ project, target: 20, online: true, registry: `http://127.0.0.1:${server.address().port}` });
    const by = (n) => advice.find((a) => a.name === n);
    assert.deepStrictEqual([by('@ngbracket/ngx-layout').action, by('@ngbracket/ngx-layout').suggested], ['upgrade', '^20.0.1']);
    assert.match(by('@ngbracket/ngx-layout').note, /Per-Angular-major releases: 20\.0\.1 declares @angular\/core >=20\.0\.0; yours only accepts 20 through the open-ended >=19\.0\.0/);
    assert.strictEqual(by('ngx-open-ended').action, 'ok');
    const cmds = doctor.commandsFor(advice, project, 20);
    assert.match(cmds.find((x) => /ng update/.test(x)), /^npx ng update .*"@ngbracket\/ngx-layout@\^20\.0\.1"/, 'it peers on Angular, so it joins ng update');
  } finally {
    server.close();
  }
  assert.strictEqual(doctor.perMajorRelease(docs['@ngbracket/ngx-layout'], 19, '19.0.0'), undefined, 'already on the matching major');
});

test('Sass rule: global color/channel functions, but not CSS functions of the same name', () => {
  const d = doctor.sassDeprecations([
    '$b: blue($c);',
    '$x: red($c) + green($c) + hue($c) + saturation($c) + lightness($c) + alpha($c);',
    '$t: opacity($c);',
    '$m: map-merge($a, $b); $n: nth($l, 1); $p: percentage(0.5); $q: unquote("x");',
    '.a { color: rgb(1, 2, 3); background: rgba($c, 0.5); width: calc(100% - 2px); height: var(--h); color: hsl(1, 2%, 3%); }',
    '.b { filter: opacity(50%) grayscale(100%) invert(1); backdrop-filter: saturate(2); }',
    '.c { filter: alpha(opacity=50); }',
    '.d { opacity: 0.5; }',
    '$e: math.div(1, 2) + color.channel($c, "blue", $space: rgb) + map.get($m, a);',
    '@function blue($x) { @return $x; }',
  ].join('\n'));
  assert.deepStrictEqual(d.names.sort(), ['alpha', 'blue', 'green', 'hue', 'lightness', 'map-merge', 'nth', 'opacity', 'percentage', 'red', 'saturation', 'unquote'].sort());
  assert.strictEqual(d.globals, 12);
  const project = new doctor.Project(copyFixture('ng16-app'));
  assert.strictEqual(doctor.scan({ project, mode: 'target', target: 20, only: ['sass/module-system'] })[0].rule.hop, 'v18+');
});

test('v21: trailing "," / ";" in structural directives is a blocker, stripped by fix; migration warning', () => {
  const root = copyFixture('ng16-app');
  const scan21 = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 21,
    only: ['template/structural-trailing-separator', 'template/control-flow-auto-migration'] });
  const trailing = scan21.find((r) => r.rule.id === 'template/structural-trailing-separator');
  assert.strictEqual(trailing.severity, 'error');
  assert.deepStrictEqual(trailing.findings.map((f) => [f.file, f.line, f.message]), [
    ['src/app/report/report.component.html', 1, '*ngIf value "!!data&&data!==null  && appdata" ends with "," or ";" (auto-fixable)'],
    ['src/app/report/report.component.html', 2, '*ngFor value "let x of xs; trackBy: byId" ends with "," or ";" (auto-fixable)'],
  ]);
  const auto = scan21.find((r) => r.rule.id === 'template/control-flow-auto-migration');
  assert.strictEqual(auto.severity, 'warning');
  assert.match(auto.findings[0].message, /^ng update will rewrite \d+ \*ngIf\/\*ngFor\/\*ngSwitch in \d+ template file\(s\); review the diff$/);
  assert.strictEqual(doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 18,
    only: ['template/structural-trailing-separator'] })[0].severity, 'warning');

  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 21, only: ['template/structural-trailing-separator'] });
  assert.deepStrictEqual(res.applied, ['template/structural-trailing-separator']);
  assert.strictEqual(read(root, 'src/app/report/report.component.html'), [
    '<div *ngIf="!!data&&data!==null  && appdata">ok</div>',
    '<ul><li *ngFor="let x of xs; trackBy: byId">{{ x }}</li></ul>',
    '<span *ngIf="fine">fine</span>',
    '',
  ].join('\n'));
});

test('templates with unbalanced tags are listed with the first unmatched tag', () => {
  const project = new doctor.Project(copyFixture('ng16-app'));
  const rule = doctor.scan({ project, mode: 'target', target: 21, only: ['template/invalid-html'] })[0];
  assert.strictEqual(rule.severity, 'warning');
  assert.deepStrictEqual(rule.findings.map((f) => [f.file, f.line, f.message, f.fixable]), [
    ['src/app/bad/bad.component.html', 4, '<b> is not closed before </section> (line 5)', false],
    ['src/app/bad/glued.component.html', 1, 'structural directive glued to another attribute — no space between them (auto-fixable)', true],
    ['src/app/bad/glued.component.html', 2, 'structural directive glued to another attribute — no space between them (auto-fixable)', true],
  ]);
  const res = doctor.fix({ project, mode: 'target', target: 21, only: ['template/invalid-html'] });
  assert.deepStrictEqual(res.changedFiles, ['src/app/bad/glued.component.html'], 'tag problems are left for a human');
  assert.strictEqual(read(project.root, 'src/app/bad/glued.component.html'),
    '<div    fxLayout.xs="column" *ngIf="data.ok">x</div>\n<div *ngIf="!!cols&&cols.length>0" style="overflow:scroll">y</div>\n');
  assert.strictEqual(doctor.separateGluedDirectives('<a *ngIf="x" [b]="y"></a>'), '<a *ngIf="x" [b]="y"></a>');
  const ok = (html) => assert.strictEqual(doctor.templateTagProblem(html), undefined, html);
  ok('<ul><li>a<li>b</ul><p>x<p>y');
  ok('<img src="a.png"><br><input [value]="a > b"><app-x />');
  ok('<!-- <div> --><div title="</span>">{{ a < b }}</div>');
  ok('<style>div > span {}</style><script>if (a < b) {}</script>');
  assert.deepStrictEqual(doctor.templateTagProblem('<div>\n</span>'), { line: 2, message: '</span> has no matching <span>' });
  assert.deepStrictEqual(doctor.templateTagProblem('<div>\n<div>\n</div>'), { line: 1, message: '<div> is never closed' });
});

test('v21: Uint8Array types near BufferSource APIs become Uint8Array<ArrayBuffer>', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/no-crypto.ts'), 'export const f = (x: Uint8Array): number => x.length;\n');
  const results = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 21, only: ['types/uint8array-buffer-source'] });
  const findings = results.flatMap((r) => r.findings);
  assert.deepStrictEqual(findings.map((f) => [f.file, f.line, f.severity, f.fixable]), [
    ['src/app/crypto.service.ts', 2, 'error', true], ['src/app/crypto.service.ts', 5, 'error', true],
    ['src/app/crypto.service.ts', 8, 'warning', false],
  ], 'parameters are a manual warning; files without crypto/TextDecoder use are left alone');
  assert.match(findings[2].message, /parameter .*check the callers \(manual\)$/);
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['@angular/core'] = '^20.3.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 21, only: ['types/uint8array-buffer-source'] });
  assert.deepStrictEqual(res.applied, ['types/uint8array-buffer-source']);
  const svc = read(root, 'src/app/crypto.service.ts');
  assert.match(svc, /private key\(\): Uint8Array<ArrayBuffer> \{/);
  assert.match(svc, /params\(\): \{ iv: Uint8Array<ArrayBuffer> \}/);
  assert.match(svc, /data: Uint8Array\)/, 'parameter types are not narrowed');
  assert.match(svc, /return new Uint8Array\(16\);/, 'constructor calls are untouched');
  assert.strictEqual(read(root, 'src/app/no-crypto.ts'), 'export const f = (x: Uint8Array): number => x.length;\n');
});

test('template parse errors come from the project @angular/compiler', async () => {
  let res = await doctor.templateParseDiagnostics(new doctor.Project(copyFixture('ng16-app')));
  assert.match(res.note, /@angular\/compiler is not installed/);
  // A separate copy: Node caches the failed package.json lookup of the folder above.
  const root = copyFixture('ng16-app');
  // A stand-in ESM compiler: reports "Unexpected token ','" like NG5002 does for `@if (a,) {`.
  installPackage(root, '@angular/compiler', { version: '21.0.0', type: 'module', exports: { '.': { default: './index.mjs' } } }, {
    'index.mjs': [
      "export const VERSION = { full: '21.0.0' };",
      'export function parseTemplate(text, url) {',
      "  const i = text.indexOf(',)');",
      '  const nl = String.fromCharCode(10);',
      "  return { errors: i < 0 ? [] : [{ msg: \"Parser Error: Unexpected token ','\" + nl + 'more', span: { start: { line: text.slice(0, i).split(nl).length - 1 } } }] };",
      '}',
    ].join('\n'),
  });
  fs.writeFileSync(path.join(root, 'src/app/report/flow.component.html'), '<p>x</p>\n@if (a && b,) {\n  <b>y</b>\n}\n');
  res = await doctor.templateParseDiagnostics(new doctor.Project(root));
  assert.strictEqual(res.note, "Templates parsed with the project's @angular/compiler 21.0.0.");
  assert.deepStrictEqual(res.result.findings.map((f) => [f.file, f.line, f.message, f.severity]), [
    ['src/app/report/flow.component.html', 2, "Parser Error: Unexpected token ','", 'error'],
  ]);
});

test("v21: '../' router links above the root are blockers (made absolute by fix), others warnings", () => {
  const root = copyFixture('ng16-app');
  const results = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 21, only: ['router/relative-link-above-root'] });
  const all = results.flatMap((r) => r.findings).map((f) => [f.file, f.line, f.severity, f.message]);
  assert.deepStrictEqual(all, [
    ['src/app/layout/shell.component.html', 1, 'error', "routerLink '../reports/notificationlist' climbs above the root (layout component (has <router-outlet>)) → '/reports/notificationlist' (auto-fixable)"],
    ['src/app/layout/user-menu.component.html', 1, 'error', "routerLink '../settings/change-password' climbs above the root (shared header/menu component, not a route target) → '/settings/change-password' (auto-fixable)"],
    ['src/app/layout/user-menu.component.html', 2, 'error', "[routerLink] '../../profile' climbs above the root (shared header/menu component, not a route target) → '/profile' (auto-fixable)"],
    ['src/app/orders/order-detail.component.ts', 7, 'error', "navigate '../../dashboard' climbs above the root (navigate() without relativeTo starts at the root) → '/dashboard' (auto-fixable)"],
    ['src/app/orders/order-detail.component.html', 1, 'warning', "routerLink '../list' — verify the route depth; Angular 21 throws NG04005 instead of clamping to the root"],
    ['src/app/orders/order-detail.component.ts', 4, 'warning', "navigate '../list' — verify the route depth; Angular 21 throws NG04005 instead of clamping to the root"],
    [undefined, undefined, 'info', "1 [routerLink] binding(s) take their path from data — check server-provided menu URLs for a leading '../'"],
  ]);
  assert.ok(!doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 20 }).some((r) => r.rule.id === 'router/relative-link-above-root'));

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['@angular/core'] = '^21.0.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['router/relative-link-above-root'] });
  assert.deepStrictEqual(res.applied, ['router/relative-link-above-root']);
  assert.match(read(root, 'src/app/layout/shell.component.html'), /routerLink="\/reports\/notificationlist"/);
  const menu = read(root, 'src/app/layout/user-menu.component.html');
  assert.match(menu, /routerLink='\/settings\/change-password'/);
  assert.match(menu, /\[routerLink\]="\['\/profile', userId\]"/);
  assert.match(menu, /\[routerLink\]="\[menu\.routerLink\]"/);
  const detail = read(root, 'src/app/orders/order-detail.component.ts');
  assert.match(detail, /navigate\(\['\/dashboard'\]\)/);
  assert.match(detail, /navigate\(\['\.\.\/list'\], \{ relativeTo/, 'relativeTo links keep their ../');
  assert.match(read(root, 'src/app/orders/order-detail.component.html'), /routerLink="\.\.\/list"/, 'warnings are not changed');
});

test('v22: RxJS 6 and rxjs-compat are blockers; deps suggests rxjs ^7.8.0', async () => {
  const root = copyFixture('ng16-app');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['rxjs-compat'] = '^6.6.7';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const project = new doctor.Project(root);
  const sev = (target, id) => doctor.scan({ project, mode: 'target', target, only: [id] }).map((r) => r.severity);
  assert.deepStrictEqual(sev(22, 'env/rxjs-version'), ['error']);
  assert.deepStrictEqual(sev(22, 'rxjs/compat-package'), ['error']);
  assert.deepStrictEqual(sev(17, 'rxjs/compat-package'), ['warning']);
  const advice = await doctor.adviseDeps({ project, target: 22 });
  assert.strictEqual(advice.find((a) => a.name === 'rxjs').suggested, '^7.8.0');
  assert.strictEqual(advice.find((a) => a.name === 'rxjs-compat').action, 'remove');
  const at12 = await doctor.adviseDeps({ project: new doctor.Project(copyFixture('ng6-app')), target: 12 });
  assert.strictEqual(at12.find((a) => a.name === 'rxjs').suggested, '^6.5.3 || ^7.0.0', 'RxJS 6 is still fine before v22');
});

test('RxJS patch imports: single operators are piped, unused patch imports removed', () => {
  const root = copyFixture('ng16-app');
  const w = (p, s) => fs.writeFileSync(path.join(root, p), s);
  w('src/app/dynamic-menu.component.ts', [
    "import { Component } from '@angular/core';",
    "import 'rxjs/add/operator/debounceTime';",
    "import 'rxjs/add/operator/toPromise';",
    '',
    'export class DynamicMenuComponent {',
    '  search: any;',
    '  http: any;',
    '  ngOnInit() {',
    '    this.search.valueChanges.debounceTime(500).subscribe((v: string) => this.load(v));',
    '  }',
    '  load(v: string) {',
    '    return this.http.get(v).toPromise();',
    '  }',
    '}',
    '',
  ].join('\n'));
  w('src/app/loan-outstanding.component.ts', "import 'rxjs/add/observable/of';\n\nexport const ids = (rows: any[]) => rows.map((r) => r.id);\n");
  w('src/app/rx-named.ts', "import { Observable, Subject } from 'rxjs/Rx';\n\nexport const s = new Subject<number>();\nexport let o: Observable<number>;\n");

  const findings = doctor.scan({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/deep-imports'] })
    .flatMap((r) => r.findings).map((f) => [f.file, f.line, f.fixable]);
  for (const expected of [
    ['src/app/dynamic-menu.component.ts', 2, true], ['src/app/dynamic-menu.component.ts', 3, true],
    ['src/app/loan-outstanding.component.ts', 1, true], ['src/app/rx-named.ts', 1, true],
    // scanner.component.ts still calls Observable.of(1).map(...): kept for a human.
    ['src/app/scanner.component.ts', 12, false], ['src/app/scanner.component.ts', 13, false],
  ]) assert.ok(findings.some((f) => JSON.stringify(f) === JSON.stringify(expected)), JSON.stringify(expected) + ' in ' + JSON.stringify(findings));

  const res = doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/deep-imports'] });
  assert.deepStrictEqual(res.applied, ['rxjs/deep-imports']);
  assert.strictEqual(read(root, 'src/app/dynamic-menu.component.ts'), [
    "import { Component } from '@angular/core';",
    "import { debounceTime } from 'rxjs/operators';",
    '',
    'export class DynamicMenuComponent {',
    '  search: any;',
    '  http: any;',
    '  ngOnInit() {',
    '    this.search.valueChanges.pipe(debounceTime(500)).subscribe((v: string) => this.load(v));',
    '  }',
    '  load(v: string) {',
    '    return this.http.get(v).toPromise();',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.strictEqual(read(root, 'src/app/loan-outstanding.component.ts'), '\nexport const ids = (rows: any[]) => rows.map((r) => r.id);\n');
  assert.match(read(root, 'src/app/rx-named.ts'), /^import \{ Observable, Subject \} from 'rxjs';/);
  const scanner = read(root, 'src/app/scanner.component.ts');
  assert.match(scanner, /import 'rxjs\/add\/operator\/map';/);
  assert.match(scanner, /import 'rxjs\/add\/observable\/of';/);
  assert.match(scanner, /from 'rxjs\/Rx';/, 'Observable from rxjs/Rx stays while Observable.of is used');
  assert.strictEqual(doctor.ensureOperatorImports("import { map } from 'rxjs/operators';\nx;", ['take', 'map']), "import { map, take } from 'rxjs/operators';\nx;");
});

test('v22: subject.next() without a value on a non-void Subject', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/alert.service.ts'), [
    "import { Subject, BehaviorSubject } from 'rxjs';",
    'export class AlertService {',
    '  private subject = new Subject<any>();',
    '  private done: Subject<void> = new Subject<void>();',
    '  private plain = new Subject();',
    "  private state = new BehaviorSubject<string>('');",
    '  clear() {',
    '    this.subject.next();',
    '    this.done.next();',
    '    this.plain.next();',
    "    this.subject.next('x');",
    '    this.state.next( );',
    '  }',
    '}',
    '',
  ].join('\n'));
  const rule = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['rxjs/subject-next-without-value'] })[0];
  assert.strictEqual(rule.severity, 'error');
  assert.deepStrictEqual(rule.findings.map((f) => [f.line, f.message]), [
    [8, 'subject.next() on a Subject<any> → subject.next(undefined) (auto-fixable)'],
    [10, 'plain.next() on a Subject<unknown> → plain.next(undefined) (auto-fixable)'],
    [12, 'state.next() on a Subject<string> → state.next(undefined) (auto-fixable)'],
  ]);
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['rxjs/subject-next-without-value'] });
  assert.deepStrictEqual(res.applied, ['rxjs/subject-next-without-value']);
  const svc = read(root, 'src/app/alert.service.ts');
  assert.ok(svc.includes('this.subject.next(undefined);\n    this.done.next();\n    this.plain.next(undefined);'), svc);
  assert.ok(svc.includes('this.state.next(undefined);'), svc);
});

test('Uint8Array rule: skipped on TypeScript 5.9+, TextDecoder-only files ignored, hop v21+', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/decode.ts'),
    'export function text(bytes: Uint8Array): string {\n  return new TextDecoder().decode(bytes);\n}\nexport function make(): Uint8Array {\n  return new Uint8Array(2);\n}\n');
  let results = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['types/uint8array-buffer-source'] });
  assert.ok(results.every((r) => r.rule.hop === 'v21+'));
  assert.ok(!results.flatMap((r) => r.findings).some((f) => f.file === 'src/app/decode.ts'), 'TextDecoder accepts any Uint8Array');
  assert.ok(results.flatMap((r) => r.findings).some((f) => f.file === 'src/app/crypto.service.ts'));
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.devDependencies.typescript = '~5.9.3';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  results = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['types/uint8array-buffer-source'] });
  assert.deepStrictEqual(results, [], 'tsc is the source of truth once TS 5.9 is installed');
});

test('v22 Node range: table, open-ended message, registry engines.node', async () => {
  const range = doctor.requirementsFor(22).node;
  assert.strictEqual(range, '^22.22.3 || ^24.15.0 || >=26.0.0');
  assert.strictEqual(doctor.nodeFit(range, '22.12.0'), 'your Node 22.12.0 does not fit');
  const msg = doctor.nodeVersionMessage('22.12.0', range, 22, ['24.15.0', '22.12.0']);
  assert.ok(msg.includes('Supported: Node 22 (>=22.22.3), 24 (>=24.15.0), 26 (>=26.0.0). '), msg);
  assert.doesNotMatch(msg, /is not supported/, 'an open-ended range has no ceiling');
  assert.match(msg, /Installed with nvm and compatible: 24\.15\.0 — nvm use 24\.15\.0/);

  const doc = { versions: {
    '21.2.0': { engines: { node: '^20.19.0 || ^22.12.0 || >=24.0.0' } },
    '22.0.0': { engines: { node: '^22.22.0 || >=24.10.0' } },
    '22.0.4': { engines: { node: '^22.22.3 || ^24.15.0 || >=26.0.0' } },
    '22.1.0-next.0': { engines: { node: '>=26.0.0' } },
  } };
  assert.deepStrictEqual(doctor.cliNodeRange(doc, 22), { range: '^22.22.3 || ^24.15.0 || >=26.0.0', cli: '22.0.4' });
  assert.strictEqual(doctor.cliNodeRange(doc, 23), undefined);

  const server = require('http').createServer((req, res) => {
    const found = decodeURIComponent(req.url.slice(1)) === '@angular/cli';
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(found ? JSON.stringify(doc) : '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const registry = `http://127.0.0.1:${server.address().port}`;
    assert.deepStrictEqual(await doctor.nodeRequirement(22, registry), { range: '^22.22.3 || ^24.15.0 || >=26.0.0', source: 'npm-registry', cli: '22.0.4' });
    assert.deepStrictEqual(await doctor.nodeRequirement(21, registry), { range: '^20.19.0 || ^22.12.0 || >=24.0.0', source: 'npm-registry', cli: '21.2.0' });
    assert.deepStrictEqual(await doctor.nodeRequirement(20, registry), { range: doctor.requirementsFor(20).node, source: 'table' }, 'falls back to the table');
    const advice = await doctor.adviseDeps({ project: new doctor.Project(copyFixture('ng16-app')), target: 22, online: true, registry });
    const node = advice.find((a) => a.name === 'node (runtime)');
    assert.strictEqual(node.suggested, '^22.22.3 || ^24.15.0 || >=26.0.0');
    assert.match(node.note, /From @angular\/cli@22\.0\.4 engines\.node\./);
  } finally {
    server.close();
  }
});

test('--apply: the CLI Node error is recognised, and deps --apply checks Node first', async () => {
  const cliOut = 'Node.js version v22.12.0 detected.\nThe Angular CLI requires a minimum Node.js version of v22.22.3 or v24.15.0 or v26.0.0.\n';
  assert.deepStrictEqual(doctor.cliNodeError(cliOut), ['22.22.3', '24.15.0', '26.0.0']);
  assert.strictEqual(doctor.cliNodeError('npm ERR! ERESOLVE'), undefined);

  const project = new doctor.Project(copyFixture('ng16-app'));
  const fail = { step: 'ng-update', packages: [], command: 'node -e "console.error(\'The Angular CLI requires a minimum Node.js version of v22.22.3.\'); process.exit(3)"' };
  const res = await doctor.applyDepCommands([fail, { step: 'uninstall', packages: [], command: 'node -e "0"' }], project);
  assert.deepStrictEqual([res.ran, res.failed.code], [[], 3], 'stops at the first failure');
  assert.match(res.failed.stderr, /requires a minimum Node\.js version of v22\.22\.3/);

  const range = doctor.requirementsFor(22).node;
  if (!require('semver').satisfies(process.versions.node, range)) {
    const { spawnSync } = require('child_process');
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli.js'), 'deps', '--target', '22', '--apply', '--yes', '--project', project.root], { encoding: 'utf8' });
    assert.strictEqual(out.status, 1);
    assert.match(out.stdout, /Not applying: Node .* does not fit the Angular 22 CLI's \^22\.22\.3 \|\| \^24\.15\.0 \|\| >=26\.0\.0\./);
    assert.match(out.stdout, /nvm install 26 && nvm use 26/);
    assert.doesNotMatch(out.stdout, /Commands/, 'fails before the dependency analysis');
  }
});

/** Copy of a fixture with @angular/core set to `core` (and optional package.json edits). */
function fixtureAt(name, core, edit) {
  const root = copyFixture(name);
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (core) pkg.dependencies['@angular/core'] = core;
  if (edit) edit(pkg);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return root;
}
const findingsOf = (root, target, id, mode = 'target') =>
  doctor.scan({ project: new doctor.Project(root), mode, target, only: [id] }).flatMap((r) => r.findings);

test('TS 6: strict default is pinned to false', () => {
  const root = copyFixture('ng16-app');
  const f = findingsOf(root, 22, 'ts/strict-default');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].severity, 'error');
  const res = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['ts/strict-default'] });
  assert.deepStrictEqual(res.changedFiles, ['tsconfig.json']);
  const json = JSON.parse(read(root, 'tsconfig.json'));
  assert.strictEqual(json.compilerOptions.strict, false);
  assert.deepStrictEqual(findingsOf(root, 22, 'ts/strict-default'), [], 'set now');
  assert.strictEqual(doctor.setJsonOption('{\n  "compilerOptions": {}\n}', 'compilerOptions', 'strict', 'false'), '{\n  "compilerOptions": {\n    "strict": false\n}\n}');
  assert.deepStrictEqual(JSON.parse(doctor.setJsonOption('{ "files": [] }', 'angularCompilerOptions', 'strictTemplates', 'false')),
    { angularCompilerOptions: { strictTemplates: false }, files: [] });
});

test('TS 6: namespace imports that are called or constructed become default imports', () => {
  const root = fixtureAt('ng16-app', '^22.0.0');
  fs.writeFileSync(path.join(root, 'src/app/dates.ts'), [
    "import * as moment from 'moment';",
    "import * as jsPDF from 'jspdf';",
    "import * as _ from 'lodash';",
    "import * as local from './shared/util';",
    'export const now = () => moment().format();',
    'export const pdf = () => new jsPDF();',
    'export const ids = (xs: any[]) => _.map(xs, (x) => x.id);',
    '',
  ].join('\n'));
  const f = findingsOf(root, 22, 'ts/called-namespace-import', 'current');
  assert.deepStrictEqual(f.map((x) => [x.line, x.severity]), [[1, 'error'], [2, 'error']]);
  assert.match(f[1].message, /new jsPDF\(\).*crashes at run time/);
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['ts/called-namespace-import'] });
  const out = read(root, 'src/app/dates.ts');
  assert.match(out, /^import moment from 'moment';\nimport jsPDF from 'jspdf';\nimport \* as _ from 'lodash';/);
  assert.match(out, /import \* as local from '\.\/shared\/util';/, 'relative imports are left alone');
});

test('TS 6: baseUrl becomes narrow paths (never "*"), downlevelIteration dropped for ES2015+', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    baseUrl: './src', paths: { '@env/*': ['environments/*'] }, downlevelIteration: true, target: 'ES2022',
  } }, null, 2));
  fs.writeFileSync(path.join(root, 'src/tsconfig.app.json'), JSON.stringify({ extends: '../tsconfig.json', compilerOptions: { downlevelIteration: true, target: 'es5' } }, null, 2));
  const f = findingsOf(root, 22, 'ts/deprecated-options');
  assert.deepStrictEqual(f.map((x) => [x.file, x.fixable]), [['src/tsconfig.app.json', false], ['tsconfig.json', true], ['tsconfig.json', true]]);
  assert.match(f[2].message, /"paths" "@env\/\*", "app\/\*"/);
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['ts/deprecated-options'] });
  const json = JSON.parse(read(root, 'tsconfig.json'));
  assert.deepStrictEqual(json.compilerOptions, { target: 'ES2022', paths: { '@env/*': ['./src/environments/*'], 'app/*': ['./src/app/*'] } });
  assert.ok(!('*' in json.compilerOptions.paths));
  assert.strictEqual(JSON.parse(read(root, 'src/tsconfig.app.json')).compilerOptions.downlevelIteration, true, 'es5 still needs it');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: './src', ignoreDeprecations: '6.0' } }));
  assert.strictEqual(findingsOf(root, 22, 'ts/deprecated-options').find((x) => x.file === 'tsconfig.json').severity, 'warning');
});

test('v22: libraries importing removed Angular APIs, known upgrades and swaps', async () => {
  const root = fixtureAt('ng16-app', null, (pkg) => Object.assign(pkg.dependencies, {
    '@swimlane/ngx-charts': '20.5.0', 'ngx-hammer-lib': '1.0.0', 'ngx-clean': '1.0.0', 'date-fns': '2.29.3', 'ngx-image-cropper': '7.0.0',
    'ngx-material-timepicker': '13.1.1', luxon: '^3.0.0', 'angular-calendar': '0.31.0',
  }));
  installPackage(root, '@swimlane/ngx-charts', { version: '20.5.0' }, { 'index.mjs': "import { ComponentFactoryResolver, Injectable } from '@angular/core';" });
  installPackage(root, 'ngx-hammer-lib', { version: '1.0.0' }, { 'index.mjs': "import * as i1 from '@angular/platform-browser';\nexport const x = i1.HAMMER_LOADER;" });
  installPackage(root, 'ngx-clean', { version: '1.0.0' }, { 'index.mjs': "import { Injectable } from '@angular/core';" });
  const f = findingsOf(root, 22, 'deps/removed-angular-apis').map((x) => x.message);
  assert.deepStrictEqual(f, [
    '@swimlane/ngx-charts@20.5.0 imports removed @angular/core: ComponentFactoryResolver → upgrade ^25.0.3',
    'ngx-hammer-lib@1.0.0 imports removed @angular/platform-browser: HAMMER_LOADER → upgrade or replace it',
  ]);
  const advice = await doctor.adviseDeps({ project: new doctor.Project(root), target: 22 });
  const by = (n) => advice.find((a) => a.name === n);
  assert.strictEqual(by('date-fns').suggested, '^2.30.0');
  assert.strictEqual(by('ngx-image-cropper').suggested, '^9.1.7', 'the v22 entry wins over the v16 one');
  assert.strictEqual(by('angular-calendar').suggested, '^0.32.2');
  assert.match(by('angular-calendar').note, /angular-draggable-droppable@\^9/);
  assert.deepStrictEqual([by('ngx-material-timepicker').action, by('ngx-material-timepicker').suggested], ['replace', 'ngx-mat-timepicker@^22.0.0']);
});

test('v22: ngx-material-timepicker → ngx-mat-timepicker and ImageCropperModule → ImageCropperComponent', () => {
  const root = fixtureAt('ng16-app', null, (pkg) => Object.assign(pkg.dependencies, { 'ngx-material-timepicker': '13.1.1', luxon: '^3.0.0', 'ngx-image-cropper': '^9.1.7' }));
  fs.writeFileSync(path.join(root, 'src/app/time.module.ts'), [
    "import { NgxMaterialTimepickerModule } from 'ngx-material-timepicker';",
    "import { ImageCropperModule, ImageCropperComponent } from 'ngx-image-cropper';",
    '@NgModule({ imports: [NgxMaterialTimepickerModule, ImageCropperModule] })',
    'export class TimeModule {}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/app/time.component.html'), '<input [ngxTimepicker]="picker"><ngx-material-timepicker #picker></ngx-material-timepicker>\n');
  assert.ok(findingsOf(root, 22, 'deps/library-api-renames').every((x) => x.fixable));
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 22, only: ['deps/library-api-renames'] });
  assert.strictEqual(read(root, 'src/app/time.module.ts').split('\n').slice(0, 3).join('\n'), [
    "import { NgxMatTimepickerModule } from 'ngx-mat-timepicker';",
    "import { ImageCropperComponent } from 'ngx-image-cropper';",
    '@NgModule({ imports: [NgxMatTimepickerModule, ImageCropperComponent] })',
  ].join('\n'));
  assert.strictEqual(read(root, 'src/app/time.component.html'), '<input [ngxMatTimepicker]="picker"><ngx-mat-timepicker #picker></ngx-mat-timepicker>\n');
  const pkg = JSON.parse(read(root, 'package.json'));
  assert.deepStrictEqual([pkg.dependencies['ngx-mat-timepicker'], pkg.dependencies['ngx-material-timepicker'], pkg.dependencies.luxon], ['^22.0.0', undefined, undefined]);
});

test('templates: loop variable "in", double button variants, extendedDiagnostics without strictTemplates', () => {
  const root = copyFixture('ng16-app');
  const w = (p, s) => fs.writeFileSync(path.join(root, p), s);
  w('src/app/loops.component.html', '<span *ngFor="let in of counter(12); let i = index">{{ i }}</span>\n@for (in of counter(3) ; track in; let j = $index) { <b>{{ j }} in total</b> }\n');
  w('src/app/loops-used.component.html', '<span *ngFor="let in of items">{{ in.name }}</span>\n');
  w('src/app/buttons.component.html', [
    '<button mat-raised-button mat-mini-fab color="primary">+</button>',
    '<!-- <button mat-button mat-icon-button>x</button> -->',
    '<a mat-button',
    '   class="x" mat-icon-button title="mat-button here">y</a>',
    '<button mat-icon-button>ok</button>',
    '',
  ].join('\n'));
  w('src/tsconfig.app.json', JSON.stringify({ extends: '../tsconfig.json', angularCompilerOptions: { strictTemplates: false, extendedDiagnostics: { checks: { optionalChainNotNullable: 'suppress' } } } }, null, 2));
  const loops = findingsOf(root, 22, 'template/loop-variable-named-in');
  assert.deepStrictEqual(loops.map((x) => [x.file, x.fixable]).sort(), [['src/app/loops-used.component.html', false], ['src/app/loops.component.html', true]]);
  assert.strictEqual(findingsOf(root, 20, 'template/loop-variable-named-in')[0].severity, 'warning');
  const buttons = findingsOf(root, 22, 'material/conflicting-button-variants');
  assert.deepStrictEqual(buttons.map((x) => [x.line, x.message]), [[1, 'mat-raised-button together with mat-mini-fab → keep mat-mini-fab (auto-fixable)'], [3, 'mat-button together with mat-icon-button → keep mat-icon-button (auto-fixable)']]);
  assert.strictEqual(findingsOf(root, 22, 'build/extended-diagnostics-without-strict-templates').length, 1);

  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 22,
    only: ['template/loop-variable-named-in', 'material/conflicting-button-variants', 'build/extended-diagnostics-without-strict-templates'] });
  assert.strictEqual(read(root, 'src/app/loops.component.html'),
    '<span *ngFor="let item of counter(12); let i = index">{{ i }}</span>\n@for (item of counter(3) ; track $index; let j = $index) { <b>{{ j }} in total</b> }\n');
  assert.match(read(root, 'src/app/loops-used.component.html'), /let in of items/);
  const html = read(root, 'src/app/buttons.component.html');
  assert.match(html, /^<button mat-mini-fab color="primary">/);
  assert.match(html, /<!-- <button mat-button mat-icon-button>x<\/button> -->/, 'comments untouched');
  assert.match(html, /<a\n {3}class="x" mat-icon-button title="mat-button here">/);
  assert.deepStrictEqual(JSON.parse(read(root, 'src/tsconfig.app.json')).angularCompilerOptions, { strictTemplates: false });
});

test('v22: ComponentFactoryResolver is removed — ViewContainerRef pattern auto-fixed, dead files noted', () => {
  const root = fixtureAt('ng16-app', '^21.0.0');
  fs.writeFileSync(path.join(root, 'src/main.ts'), "import './app/app.module';\n");
  const w = (p, s) => fs.writeFileSync(path.join(root, p), s);
  w('src/app/host.component.ts', [
    "import { Component, ComponentFactoryResolver, ViewContainerRef } from '@angular/core';",
    "import { ScannerComponent } from './scanner.component';",
    'export class HostComponent {',
    '  constructor(private vcr: ViewContainerRef, private resolver: ComponentFactoryResolver) {}',
    '  open() {',
    '    const factory = this.resolver.resolveComponentFactory(ScannerComponent);',
    '    return this.vcr.createComponent(factory);',
    '  }',
    '  again() {',
    '    return this.vcr.createComponent(this.resolver.resolveComponentFactory(ScannerComponent));',
    '  }',
    '}',
    '',
  ].join('\n'));
  w('src/app/dead.service.ts', [
    "import { ComponentFactoryResolver, Injector } from '@angular/core';",
    'export class DeadService {',
    '  constructor(private cfr: ComponentFactoryResolver, private injector: Injector) {}',
    '  make(c: any) { return this.cfr.resolveComponentFactory(c).create(this.injector); }',
    '}',
    '',
  ].join('\n'));
  w('src/app/app.module.ts', "import { HostComponent } from './host.component';\nexport const all = [HostComponent];\n");
  w('src/app/hammer.ts', "import { HAMMER_LOADER } from '@angular/platform-browser';\nexport const p = { provide: HAMMER_LOADER, useValue: () => import('hammerjs') };\n");
  const f = findingsOf(root, 22, 'core/component-factory-resolver');
  assert.ok(f.every((x) => x.severity === 'error'));
  const dead = f.filter((x) => x.file === 'src/app/dead.service.ts');
  assert.ok(dead.length && dead.every((x) => /removed in Angular 22 \(not in the build graph today; it fails as soon as it's imported\) \(manual\)$/.test(x.message)), JSON.stringify(dead));
  assert.ok(f.filter((x) => x.file === 'src/app/host.component.ts').every((x) => x.fixable && !/build graph/.test(x.message)));
  assert.strictEqual(findingsOf(root, 18, 'core/component-factory-resolver')[0].severity, 'warning');
  assert.strictEqual(findingsOf(root, 22, 'core/hammer-loader').length, 2);

  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['core/component-factory-resolver'] });
  assert.strictEqual(read(root, 'src/app/host.component.ts'), [
    "import { Component, ViewContainerRef } from '@angular/core';",
    "import { ScannerComponent } from './scanner.component';",
    'export class HostComponent {',
    '  constructor(private vcr: ViewContainerRef) {}',
    '  open() {',
    '    return this.vcr.createComponent(ScannerComponent);',
    '  }',
    '  again() {',
    '    return this.vcr.createComponent(ScannerComponent);',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.match(read(root, 'src/app/dead.service.ts'), /resolveComponentFactory\(c\)\.create/, 'other patterns stay manual');
});

/** Writes an angular.json with one app using `builder` (and optional build options). */
function setBuilder(root, builder, options = {}) {
  fs.writeFileSync(path.join(root, 'angular.json'), JSON.stringify({
    version: 1, projects: { tw: { sourceRoot: 'src', architect: { build: { builder, options: { browser: 'src/main.ts', outputPath: 'dist/tw', ...options } } } } },
  }, null, 2));
}

test('esbuild application builder: url() made relative to the component, missing files dropped, ^ URLs flagged', () => {
  const root = fixtureAt('ng16-app', '^22.0.0');
  setBuilder(root, '@angular/build:application');
  fs.writeFileSync(path.join(root, 'src/app/pay/legacy.component.html'), "<style>\n  .a { background: url('^assets/img/logo.png') no-repeat; color: red; }\n</style>\n");
  fs.writeFileSync(path.join(root, 'src/styles.scss'), ".x { background-image: url('^assets/img/logo.png'); }\n.y { background: url('^assets/img/gone.png'); }\n");
  const f = findingsOf(root, 22, 'template/style-relative-url', 'current');
  assert.ok(f.every((x) => x.severity === 'error'));
  assert.ok(f.some((x) => /url\(assets\/img\/logo\.png\).*→ '\.\.\/\.\.\/assets\/img\/logo\.png'/.test(x.message)), JSON.stringify(f));
  assert.ok(f.some((x) => /url\(assets\/img\/bg\.jpg\).*→ declaration removed/.test(x.message)));
  assert.ok(f.some((x) => x.file === 'src/styles.scss' && /does not support the \^ prefix/.test(x.message)));

  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['template/style-relative-url'] });
  const pay = read(root, 'src/app/pay/pay.component.html');
  assert.doesNotMatch(pay, /bg\.jpg/, 'a 404 declaration is removed');
  assert.match(pay, /\.logo \{ background: url\(\.\.\/\.\.\/assets\/img\/logo\.png\) no-repeat; \}/);
  assert.match(read(root, 'src/app/pay/legacy.component.html'), /url\('\.\.\/\.\.\/assets\/img\/logo\.png'\) no-repeat; color: red;/);
  assert.strictEqual(read(root, 'src/styles.scss'), ".x { background-image: url('./assets/img/logo.png'); }\n.y { }\n");

  // Webpack builder: ^ URLs are only a warning before the builder switch.
  const wp = copyFixture('ng16-app');
  setBuilder(wp, '@angular-devkit/build-angular:browser');
  fs.writeFileSync(path.join(wp, 'src/styles.scss'), ".x { background-image: url('^assets/img/logo.png'); }\n");
  const w = findingsOf(wp, 19, 'template/style-relative-url').find((x) => x.file === 'src/styles.scss');
  assert.deepStrictEqual([w.severity, w.fixable], ['warning', false]);
});

test('esbuild: jsdom pulled in by fabric/canvg gets externalDependencies', () => {
  const root = copyFixture('ng16-app');
  setBuilder(root, '@angular-devkit/build-angular:application');
  installPackage(root, 'fabric', { version: '3.6.6' });
  installPackage(root, 'canvas', { version: '2.11.0' });
  const f = findingsOf(root, 18, 'build/esbuild-external-dependencies');
  assert.deepStrictEqual(f.map((x) => [x.severity, x.message]), [['error', 'tw: fabric@3.6.6 installed — add "externalDependencies": ["jsdom", "canvas"] (auto-fixable)']]);
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['build/esbuild-external-dependencies'] });
  assert.deepStrictEqual(JSON.parse(read(root, 'angular.json')).projects.tw.architect.build.options.externalDependencies, ['jsdom', 'canvas']);
  assert.deepStrictEqual(findingsOf(root, 18, 'build/esbuild-external-dependencies'), []);
  setBuilder(root, '@angular-devkit/build-angular:browser');
  assert.deepStrictEqual(findingsOf(root, 18, 'build/esbuild-external-dependencies'), [], 'webpack honours the browser maps');
});

test('jspdf 1 → 2 is reported as a breaking check, never an automatic upgrade', async () => {
  const root = fixtureAt('ng16-app', null, (pkg) => Object.assign(pkg.dependencies, { jspdf: '^1.5.3', 'jspdf-autotable': '^3.5.0' }));
  fs.writeFileSync(path.join(root, 'src/app/report.ts'), "import jsPDF from 'jspdf';\nconst d = new jsPDF();\nd.setFontStyle('bold');\nd.setFontStyle('normal');\nd.fromHTML('<p></p>', 1, 1);\nd.text('x', 10, 10, 'center');\n");
  const f = findingsOf(root, 22, 'deps/jspdf-2-breaking-api');
  assert.match(f[0].message, /in use: setFontStyle\(\) ×2, fromHTML\(\) ×1, text\(\.\.\., 'center'\) flag ×1$/);
  const advice = await doctor.adviseDeps({ project: new doctor.Project(root), target: 22 });
  const jspdf = advice.find((a) => a.name === 'jspdf');
  assert.strictEqual(jspdf.action, 'check');
  assert.ok(!doctor.commandsFor(advice, new doctor.Project(root), 22).some((c) => /jspdf@/.test(c)));
});

test('file references with the wrong letter case are rewritten to the on-disk casing', () => {
  const root = copyFixture('ng16-app');
  const w = (p, s) => fs.writeFileSync(path.join(root, p), s);
  w('src/app/pay/occupationPopup.html', '<p>x</p>\n');
  w('src/app/pay/occupation.component.ts', "import { noop } from '../Shared/Util';\n@Component({ templateUrl: './occupationpopup.html', styleUrls: ['./OCC.scss'] })\nexport class OccupationComponent {}\n");
  w('src/app/pay/occ.scss', ".l { background: url('../../assets/img/Logo.png'); }\n");
  const f = findingsOf(root, 18, 'build/file-name-case').map((x) => [x.file, x.message]);
  assert.deepStrictEqual(f, [
    ['src/app/pay/occupation.component.ts', "'./occupationpopup.html' → './occupationPopup.html' (case differs from the file on disk, auto-fixable)"],
    ['src/app/pay/occupation.component.ts', "'./OCC.scss' → './occ.scss' (case differs from the file on disk, auto-fixable)"],
    ['src/app/pay/occupation.component.ts', "'../Shared/Util' → '../shared/util' (case differs from the file on disk, auto-fixable)"],
    ['src/app/pay/occ.scss', "'../../assets/img/Logo.png' → '../../assets/img/logo.png' (case differs from the file on disk, auto-fixable)"],
  ]);
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['build/file-name-case'] });
  assert.strictEqual(read(root, 'src/app/pay/occupation.component.ts'),
    "import { noop } from '../shared/util';\n@Component({ templateUrl: './occupationPopup.html', styleUrls: ['./occ.scss'] })\nexport class OccupationComponent {}\n");
  assert.deepStrictEqual(findingsOf(root, 18, 'build/file-name-case'), []);
});

test('package.json scripts: webpack-only flags, duplicate configuration, npm run without --, huge old space', () => {
  const ram = 16384;
  const p = (s, esbuild = true) => doctor.scriptProblems(s, esbuild, ram).map((x) => x.kind);
  assert.deepStrictEqual(p('ng build --configuration production --build-optimizer --vendor-chunk=true --deploy-url /x/'), ['webpack-flag', 'webpack-flag', 'webpack-flag']);
  assert.deepStrictEqual(p('ng build --build-optimizer', false), [], 'the webpack builder accepts them');
  assert.deepStrictEqual(p('ng build --configuration production --configuration=uat'), ['duplicate-configuration']);
  assert.deepStrictEqual(p('npm run ng build --configuration=uat'), ['npm-run-without-dashes']);
  assert.deepStrictEqual(p('npm run ng -- build --configuration=uat'), []);
  assert.deepStrictEqual(p('node --max_old_space_size=84384 node_modules/@angular/cli/bin/ng serve'), ['old-space']);
  assert.deepStrictEqual(p('node --max_old_space_size=8192 ./node_modules/.bin/ng build'), []);
  assert.strictEqual(doctor.fixScript('ng build --build-optimizer --configuration production && cp -r dist x', true), 'ng build --configuration production && cp -r dist x');
  assert.strictEqual(doctor.fixScript('npm run ng build --configuration=uat', true), 'npm run ng -- build --configuration=uat');

  const root = copyFixture('ng16-app');
  setBuilder(root, '@angular/build:application');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts = { prod: 'ng build --configuration production --build-optimizer', uat: 'npm run ng build --configuration=uat', ok: 'ng serve' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  assert.strictEqual(findingsOf(root, 18, 'build/package-scripts').length, 2);
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['build/package-scripts'] });
  assert.deepStrictEqual(JSON.parse(read(root, 'package.json')).scripts, { prod: 'ng build --configuration production', uat: 'npm run ng -- build --configuration=uat', ok: 'ng serve' });
});

test('application builder output: deploy files still copying dist/<app>', () => {
  const root = copyFixture('ng16-app');
  setBuilder(root, '@angular/build:application', { outputPath: { base: 'dist/live' } });
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/deploy.yml'), 'steps:\n  - run: npm run prod\n  - run: aws s3 sync dist/live s3://bucket\n');
  fs.writeFileSync(path.join(root, 'deploy.sh'), 'cp -r dist/live/browser/* /var/www\n');
  assert.deepStrictEqual(findingsOf(root, 18, 'build/application-builder-output').map((x) => [x.file, x.line]), [['.github/workflows/deploy.yml', 3]]);
});

test('MDC buttons: trailing icon gets iconPositionEnd; old selectors and overflow-x are flagged', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/menu.component.html'), [
    '<button mat-button (click)="open()">Reports <mat-icon>arrow_drop_down</mat-icon></button>',
    '<button mat-button><mat-icon>home</mat-icon> Home</button>',
    '<button mat-raised-button>Save <mat-icon iconPositionEnd>check</mat-icon></button>',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/app/menu.component.scss'), '.menu .mat-button { overflow-x: hidden; }\n.mat-button-wrapper { color: red; }\n.mat-button-toggle { color: blue; }\n');
  const icons = findingsOf(root, 18, 'material/button-trailing-icon');
  assert.deepStrictEqual(icons.map((x) => x.line), [1]);
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['material/button-trailing-icon'] });
  assert.match(read(root, 'src/app/menu.component.html'), /^<button mat-button \(click\)="open\(\)">Reports <mat-icon iconPositionEnd>arrow_drop_down<\/mat-icon><\/button>\n<button mat-button><mat-icon>home<\/mat-icon> Home<\/button>/);
  const mdc = findingsOf(root, 18, 'material/mdc-style-overrides').filter((x) => x.file === 'src/app/menu.component.scss').map((x) => x.message);
  assert.deepStrictEqual(mdc, [
    'Override of .mat-button will no longer match → .mat-mdc-button',
    'Override of .mat-button-wrapper will no longer match → .mdc-button__label',
    'overflow-x: hidden/auto on an MDC button — overflow-y becomes auto and its 48px touch target adds a scrollbar; use overflow: hidden and .mat-mdc-button-touch-target { display: none }',
  ], '.mat-button-toggle is a different component');
});

test('perfect-scrollbar info, VS Code watcher settings and the vscode command', () => {
  const root = fixtureAt('ng16-app', null, (pkg) => { pkg.dependencies['ngx-om-perfect-scrollbar'] = '^15.1.0'; });
  fs.writeFileSync(path.join(root, 'src/app/side.component.html'), '<perfect-scrollbar><mat-accordion></mat-accordion></perfect-scrollbar>\n');
  assert.match(findingsOf(root, 18, 'deps/perfect-scrollbar-content')[0].message, /used in 1 template\(s\) — prefer native overflow-y: auto/);
  assert.strictEqual(findingsOf(root, 18, 'workspace/vscode-watcher-exclude').length, 1);
  fs.mkdirSync(path.join(root, '.vscode'));
  fs.writeFileSync(path.join(root, '.vscode/settings.json'), '{\n  // mine\n  "editor.tabSize": 2,\n  "files.watcherExclude": { "**/tmp/**": true }\n}\n');
  const { spawnSync } = require('child_process');
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli.js'), 'vscode', '--project', root], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  const settings = JSON.parse(read(root, '.vscode/settings.json'));
  assert.strictEqual(settings['editor.tabSize'], 2);
  assert.deepStrictEqual(Object.keys(settings['files.watcherExclude']).sort(), ['**/.angular/**', '**/.git/objects/**', '**/dist/**', '**/node_modules/**', '**/tmp/**']);
  assert.strictEqual(settings['typescript.tsserver.maxTsServerMemory'], 3072);
  assert.deepStrictEqual(findingsOf(root, 18, 'workspace/vscode-watcher-exclude'), []);
});

test('the same component declared in two NgModules', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/main.ts'), "import './app/a.module';\nimport './app/b.module';\n");
  const w = (p, s) => fs.writeFileSync(path.join(root, p), s);
  w('src/app/twice.component.ts', 'export class TwiceComponent {}\n');
  w('src/app/pay/twice.component.ts', 'export class TwiceComponent {}\n');
  w('src/app/a.module.ts', "import { TwiceComponent } from './twice.component';\n@NgModule({ declarations: [TwiceComponent] })\nexport class AModule {}\n");
  w('src/app/b.module.ts', "import { TwiceComponent } from './twice.component';\n@NgModule({ declarations: [TwiceComponent] })\nexport class BModule {}\n");
  w('src/app/c.module.ts', "import { TwiceComponent as Other } from './pay/twice.component';\n@NgModule({ declarations: [Other] })\nexport class CModule {}\n");
  let f = findingsOf(root, 18, 'core/component-in-two-modules');
  assert.deepStrictEqual(f.map((x) => [x.file, x.severity, x.message]), [
    ['src/app/a.module.ts', 'error', 'TwiceComponent is also declared in src/app/b.module.ts'],
    ['src/app/b.module.ts', 'error', 'TwiceComponent is also declared in src/app/a.module.ts'],
  ], 'a same-named class from another file is a different component');
  fs.writeFileSync(path.join(root, 'src/main.ts'), "import './app/a.module';\n");
  f = findingsOf(root, 18, 'core/component-in-two-modules');
  assert.ok(f.every((x) => x.severity === 'warning' && /not both in the build graph today/.test(x.message)));
});

test('MDC slider: bindings move to <input matSliderThumb>, thumbLabel/tickInterval renamed', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/slider.component.html'), [
    '<mat-slider class="m" [max]="max1" [min]="min1" thumbLabel tickInterval="1" [(ngModel)]="value1" (change)="go()"></mat-slider>',
    '<mat-slider vertical [(ngModel)]="v"></mat-slider>',
    '<mat-slider [max]="9"><input matSliderThumb [(ngModel)]="ok"></mat-slider>',
    '',
  ].join('\n'));
  const f = findingsOf(root, 17, 'material/mdc-slider');
  assert.deepStrictEqual(f.map((x) => [x.line, x.severity, x.fixable]), [[1, 'error', true], [2, 'error', false]]);
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['material/mdc-slider'] });
  assert.strictEqual(read(root, 'src/app/slider.component.html').split('\n')[0],
    '<mat-slider class="m" [max]="max1" [min]="min1" discrete showTickMarks><input matSliderThumb [(ngModel)]="value1" (change)="go()"></mat-slider>');
  assert.strictEqual(doctor.migrateSliderTag(' [thumbLabel]="true" formControlName="x"', ''), '<mat-slider [discrete]="true"><input matSliderThumb formControlName="x"></mat-slider>');
});

test('library .forRoot() removed (ngx-material-timepicker 13) and the perfect-scrollbar fork', async () => {
  const root = fixtureAt('ng16-app', null, (pkg) => Object.assign(pkg.dependencies, { 'ngx-material-timepicker': '^13.1.1', 'ngx-perfect-scrollbar': '^10.1.1' }));
  fs.writeFileSync(path.join(root, 'src/app/time.module.ts'), [
    "import { NgxMaterialTimepickerModule } from 'ngx-material-timepicker';",
    "import { PerfectScrollbarModule } from 'ngx-perfect-scrollbar';",
    '@NgModule({ imports: [NgxMaterialTimepickerModule.forRoot(), PerfectScrollbarModule] })',
    'export class TimeModule {}',
    '',
  ].join('\n'));
  assert.strictEqual(findingsOf(root, 16, 'deps/for-root-removed').length, 1);
  assert.strictEqual(findingsOf(root, 16, 'deps/perfect-scrollbar-fork').length, 2);
  const advice = await doctor.adviseDeps({ project: new doctor.Project(root), target: 16 });
  const ps = advice.find((a) => a.name === 'ngx-perfect-scrollbar');
  assert.deepStrictEqual([ps.action, ps.suggested], ['replace', 'ngx-om-perfect-scrollbar@^16.0.0']);
  const cmds = doctor.commandsFor(advice, new doctor.Project(root), 16);
  assert.ok(cmds.some((c) => /npm install --save .*"ngx-om-perfect-scrollbar@\^16\.0\.0"/.test(c)), cmds.join('\n'));
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['deps/for-root-removed', 'deps/perfect-scrollbar-fork'] });
  const mod = read(root, 'src/app/time.module.ts');
  assert.match(mod, /imports: \[NgxMaterialTimepickerModule, PerfectScrollbarModule\]/);
  assert.match(mod, /from 'ngx-om-perfect-scrollbar'/);
  assert.strictEqual(JSON.parse(read(root, 'package.json')).dependencies['ngx-om-perfect-scrollbar'], '^16.0.0');
  // Before 13, forRoot() still exists.
  const old = fixtureAt('ng16-app', null, (pkg) => { pkg.dependencies['ngx-material-timepicker'] = '^5.5.3'; });
  fs.writeFileSync(path.join(old, 'src/app/t.ts'), 'export const x = [NgxMaterialTimepickerModule.forRoot()];\n');
  assert.deepStrictEqual(findingsOf(old, 16, 'deps/for-root-removed'), []);
  assert.strictEqual(doctor.knownBreaker('angular-calendar', '0.28.28', 16).suggested, '^0.31.1');
});

test('builder peers skipped by --legacy-peer-deps (webpack)', () => {
  const root = copyFixture('ng16-app');
  setBuilder(root, '@angular-devkit/build-angular:browser');
  installPackage(root, '@angular-devkit/build-angular', { version: '16.2.0', peerDependencies: { webpack: '^5.30.0', typescript: '>=4.9.3 <5.2' }, peerDependenciesMeta: {} });
  assert.deepStrictEqual(findingsOf(root, 16, 'deps/build-angular-peers').map((x) => [x.severity, x.message]), [
    ['error', 'webpack is a peer of @angular-devkit/build-angular@16.2.0 but is not installed → npm i -D "webpack@^5.30.0"'],
  ]);
  installPackage(root, 'webpack', { version: '5.88.0' });
  assert.deepStrictEqual(findingsOf(root, 16, 'deps/build-angular-peers'), []);
});

test('RxJS 7: subscribe(next, error, complete) becomes an observer object; single callbacks stay', () => {
  const src = [
    'this.api.get().subscribe(data => {',
    '  this.rows = data;',
    '}, err => {',
    '  this.fail(err);',
    '});',
    'a$.subscribe(v => x(v), null, () => done());',
    'b$.subscribe(v => y(v));',
    'c$.subscribe({ next: v => z(v) });',
    'd$.subscribe(v => {',
    '  inner$.subscribe(w => use(w), e => log(e));',
    '}, e => log(e));',
    '',
  ].join('\n');
  assert.strictEqual(doctor.multiCallbackSubscribes('x.ts', src).length, 4);
  assert.strictEqual(doctor.migrateSubscribeCallbacks('x.ts', src), [
    'this.api.get().subscribe({ next: data => {',
    '  this.rows = data;',
    '}, error: err => {',
    '  this.fail(err);',
    '} });',
    'a$.subscribe({ next: v => x(v), complete: () => done() });',
    'b$.subscribe(v => y(v));',
    'c$.subscribe({ next: v => z(v) });',
    'd$.subscribe({ next: v => {',
    '  inner$.subscribe({ next: w => use(w), error: e => log(e) });',
    '}, error: e => log(e) });',
    '',
  ].join('\n'));

  const root = fixtureAt('ng16-app', '^22.0.0', (pkg) => { pkg.dependencies.rxjs = '^7.8.0'; });
  fs.writeFileSync(path.join(root, 'src/app/sub.ts'), 'export const f = (o: any) => o.subscribe((v: any) => v, (e: any) => e);\n');
  const f = findingsOf(root, 22, 'rxjs/subscribe-callbacks', 'current');
  assert.deepStrictEqual(f.map((x) => [x.file, x.severity, x.message]), [['src/app/sub.ts', 'warning', '1 subscribe(next, error…) call(s) → subscribe({ next, error }) (auto-fixable)']]);
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/subscribe-callbacks'] });
  assert.strictEqual(read(root, 'src/app/sub.ts'), 'export const f = (o: any) => o.subscribe({ next: (v: any) => v, error: (e: any) => e });\n');
  const rx6 = copyFixture('ng16-app');
  fs.writeFileSync(path.join(rx6, 'src/app/sub.ts'), 'export const f = (o: any) => o.subscribe((v: any) => v, (e: any) => e);\n');
  assert.deepStrictEqual(findingsOf(rx6, 17, 'rxjs/subscribe-callbacks'), [], 'RxJS 6 does not deprecate them');
});

test('esbuild: with jsdom external, ng serve must not pre-bundle fabric (Failed to resolve module specifier "jsdom")', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'angular.json'), JSON.stringify({ version: 1, projects: { tw: { sourceRoot: 'src', architect: {
    build: { builder: '@angular/build:application', options: { browser: 'src/main.ts', externalDependencies: ['jsdom'] } },
    serve: { builder: '@angular/build:dev-server', options: { buildTarget: 'tw:build' } },
  } } } }, null, 2));
  installPackage(root, 'fabric', { version: '3.6.6' });
  installPackage(root, 'canvg', { version: '1.5.3' });
  assert.deepStrictEqual(findingsOf(root, 18, 'build/esbuild-external-dependencies'), [], 'nothing imports fabric yet');
  fs.writeFileSync(path.join(root, 'src/app/crop.ts'), "import 'fabric';\n");
  const f = findingsOf(root, 18, 'build/esbuild-external-dependencies');
  assert.deepStrictEqual(f.map((x) => x.message), [
    'tw: ng serve pre-bundles fabric with jsdom external → "Failed to resolve module specifier \\"jsdom\\"" in the browser — add "prebundle": { "exclude": ["fabric"] } (auto-fixable)',
  ]);
  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['build/esbuild-external-dependencies'] });
  const serve = JSON.parse(read(root, 'angular.json')).projects.tw.architect.serve.options;
  assert.deepStrictEqual(serve.prebundle, { exclude: ['fabric'] });
  assert.deepStrictEqual(findingsOf(root, 18, 'build/esbuild-external-dependencies'), []);
});

test('MDC chips: display-only <mat-chip-list> becomes <mat-chip-set>, input/selection lists are manual', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/chips.component.html'), [
    '<mat-chip-list aria-label="status">',
    '  <mat-chip>{{ status }}</mat-chip>',
    '</mat-chip-list>',
    '<mat-chip-list #tags><mat-chip *ngFor="let t of tags" (removed)="drop(t)">{{ t }}</mat-chip>',
    '  <input [matChipInputFor]="tags"></mat-chip-list>',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/app/chips.ts'), "import { MatChipList } from '@angular/material/chips';\nexport let l: MatChipList;\n");
  const f = findingsOf(root, 17, 'material/mdc-chip-list');
  assert.deepStrictEqual(f.map((x) => [x.file, x.line, x.fixable]), [
    ['src/app/chips.component.html', 1, true], ['src/app/chips.component.html', 4, false],
    ['src/app/chips.ts', 1, false], ['src/app/chips.ts', 2, false],
  ]);
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['material/mdc-chip-list'] });
  const html = read(root, 'src/app/chips.component.html');
  assert.match(html, /^<mat-chip-set aria-label="status">\n {2}<mat-chip>\{\{ status \}\}<\/mat-chip>\n<\/mat-chip-set>/);
  assert.match(html, /<mat-chip-list #tags>/, 'input lists stay for a human');
});

test('opt-in observer style: single inline callbacks get { next }, observers and subjects are left alone', () => {
  const src = [
    'a$.subscribe(v => x(v));',
    'b$.subscribe(function (v) { y(v); });',
    'c$.subscribe(this.subject);',
    'd$.subscribe(observer);',
    'e$.subscribe(v => f(v), e => g(e));',
    'f$.subscribe();',
    '',
  ].join('\n');
  assert.strictEqual(doctor.migrateSubscribeCallbacks('x.ts', src, true), [
    'a$.subscribe({ next: v => x(v) });',
    'b$.subscribe({ next: function (v) { y(v); } });',
    'c$.subscribe(this.subject);',
    'd$.subscribe(observer);',
    'e$.subscribe({ next: v => f(v), error: e => g(e) });',
    'f$.subscribe();',
    '',
  ].join('\n'));
  assert.strictEqual(doctor.migrateSubscribeCallbacks('x.ts', src), src.replace('e$.subscribe(v => f(v), e => g(e));', 'e$.subscribe({ next: v => f(v), error: e => g(e) });'), 'without the opt-in only deprecated calls change');

  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/sub.ts'), 'export const f = (o: any) => o.subscribe((v: any) => v);\n');
  const r = doctor.scan({ project: new doctor.Project(root), mode: 'target', target: 17, only: ['rxjs/subscribe-observer-style'] })[0];
  assert.strictEqual(r.severity, 'info');
  assert.deepStrictEqual(doctor.fix({ project: new doctor.Project(root), mode: 'current', all: true }).applied.includes('rxjs/subscribe-observer-style'), false, 'never applied unless named');
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['rxjs/subscribe-observer-style'] });
  assert.strictEqual(read(root, 'src/app/sub.ts'), 'export const f = (o: any) => o.subscribe({ next: (v: any) => v });\n');
});

test('Sass in a .css component stylesheet is renamed to .scss (dry run writes nothing)', () => {
  const root = copyFixture('ng16-app');
  const dir = path.join(root, 'src/app/search');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mat-select-search.component.css'), '$mat-menu-side-padding: 16px !default;\n.x { padding: $mat-menu-side-padding; }\n');
  fs.writeFileSync(path.join(dir, 'mat-select-search.component.ts'), "@Component({ selector: 's', template: '', styleUrls: ['./mat-select-search.component.css'] })\nexport class S {}\n");
  fs.writeFileSync(path.join(dir, 'plain.component.css'), '.a { color: red; & .b { color: blue; } }\n');
  const f = findingsOf(root, 18, 'build/sass-in-css');
  assert.deepStrictEqual(f.map((x) => [x.file, x.line, x.fixable]), [['src/app/search/mat-select-search.component.css', 1, true]], 'native CSS nesting is not Sass');

  const dry = doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['build/sass-in-css'], dryRun: true });
  assert.deepStrictEqual(dry.changedFiles.sort(), ['src/app/search/mat-select-search.component.css', 'src/app/search/mat-select-search.component.scss', 'src/app/search/mat-select-search.component.ts']);
  assert.ok(fs.existsSync(path.join(dir, 'mat-select-search.component.css')), 'dry run deletes nothing');

  doctor.fix({ project: new doctor.Project(root), mode: 'target', target: 18, only: ['build/sass-in-css'] });
  assert.ok(!fs.existsSync(path.join(dir, 'mat-select-search.component.css')));
  assert.match(read(root, 'src/app/search/mat-select-search.component.scss'), /^\$mat-menu-side-padding: 16px !default;/);
  assert.match(read(root, 'src/app/search/mat-select-search.component.ts'), /styleUrls: \['\.\/mat-select-search\.component\.scss'\]/);
});

test('packages declared but not installed, deprecated build-angular builders, dev-server settings', () => {
  const root = fixtureAt('ng16-app', '^22.0.0', (pkg) => Object.assign(pkg.dependencies, { 'ngx-mat-timepicker': '^22.0.0', '@ngbracket/ngx-layout': '^22.0.0', 'local-lib': 'file:../lib' }));
  installPackage(root, 'zone.js', { version: '0.15.0' });
  const missing = doctor.notInstalled(new doctor.Project(root));
  assert.ok(missing.includes('ngx-mat-timepicker') && missing.includes('@ngbracket/ngx-layout') && !missing.includes('zone.js') && !missing.includes('local-lib'));
  const ni = findingsOf(root, 22, 'deps/not-installed', 'current');
  assert.strictEqual(ni[0].severity, 'error');
  assert.match(ni[0].message, /^\d+ declared package\(s\) not installed: .+ → npm install \(--legacy-peer-deps on peer conflicts\)$/);

  fs.writeFileSync(path.join(root, 'angular.json'), JSON.stringify({
    version: 1, cli: { cache: { enabled: false } },
    projects: { app: { architect: {
      build: { builder: '@angular-devkit/build-angular:application', options: { browser: 'src/main.ts' }, configurations: { dev: { outputHashing: 'all' }, production: { outputHashing: 'all' } } },
      serve: { builder: '@angular-devkit/build-angular:dev-server', configurations: { dev: { buildTarget: 'app:build:dev' } } },
    } } },
  }, null, 2));
  const b = findingsOf(root, 22, 'build/build-angular-package', 'current');
  assert.deepStrictEqual(b.map((x) => x.message), [
    '"@angular-devkit/build-angular:application" → "@angular/build:application" (auto-fixable)',
    '"@angular-devkit/build-angular:dev-server" → "@angular/build:dev-server" (auto-fixable)',
  ]);
  const s = findingsOf(root, 22, 'build/dev-server-settings', 'current').map((x) => x.message);
  assert.deepStrictEqual(s, [
    'cli.cache.enabled is false — the dev server cannot pre-bundle dependencies (slower ng serve)',
    'app: ng serve --configuration dev builds with outputHashing "all" — HMR is disabled; use "none" for serving',
  ]);
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['build/build-angular-package'] });
  const ws = JSON.parse(read(root, 'angular.json'));
  assert.deepStrictEqual([ws.projects.app.architect.build.builder, ws.projects.app.architect.serve.builder], ['@angular/build:application', '@angular/build:dev-server']);
  assert.strictEqual(JSON.parse(read(root, 'package.json')).devDependencies['@angular/build'], '^22.0.0');
});

test('after a fix changes package.json the CLI installs (or names the exact command), and shows its version', () => {
  const root = fixtureAt('ng16-app', null, (pkg) => { pkg.dependencies['ngx-perfect-scrollbar'] = '^10.1.1'; });
  installPackage(root, 'zone.js', { version: '0.13.0' });
  assert.strictEqual(doctor.postFixInstallCommand(new doctor.Project(root), ['src/x.ts']).startsWith('npm install'), true, 'packages are missing');
  assert.strictEqual(doctor.postFixInstallCommand(new doctor.Project(root), ['package.json'], true), 'npm install --legacy-peer-deps');

  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'dist', 'cli.js');
  const version = require('../package.json').version;
  // Not a TTY and no --install: nothing is installed, the exact command is printed.
  const out = spawnSync(process.execPath, [cli, 'current', '--fix', '--only', 'deps/perfect-scrollbar-fork', '--legacy-peer-deps', '--project', root], { encoding: 'utf8', input: '' });
  assert.match(out.stdout, new RegExp(`^ngx-upgrade-doctor ${version.replace(/\./g, '\.')} · `));
  assert.match(out.stdout, /package\(s\) in package\.json are not installed \(.*\) — the build fails until you run: npm install --legacy-peer-deps/);
  assert.strictEqual(JSON.parse(read(root, 'package.json')).dependencies['ngx-om-perfect-scrollbar'], '^16.0.0');
  assert.ok(!fs.existsSync(path.join(root, 'node_modules/ngx-om-perfect-scrollbar')), 'nothing installed without --install or a yes');
  const dry = spawnSync(process.execPath, [cli, 'current', '--fix', '--dry-run', '--project', copyFixture('ng16-app')], { encoding: 'utf8', input: '' });
  assert.doesNotMatch(dry.stdout, /the build fails until you run|Run "npm install|Installed\. /, 'dry runs never install or nag');
});

test('deps on an app already on the target: ng update only what is behind, removals first, ELSPROBLEMS explained', async () => {
  const root = fixtureAt('ng16-app', '^22.2.3', (pkg) => {
    Object.assign(pkg.dependencies, { '@angular/cli': '^22.2.2', '@angular/material': '^21.2.14', '@angular/cdk': '^21.2.14', 'ngx-old': '^1.0.4' });
    delete pkg.dependencies['@angular/flex-layout'];
  });
  installPackage(root, '@angular/core', { version: '22.2.3' });
  installPackage(root, '@angular/cli', { version: '22.2.2' });
  installPackage(root, '@angular/material', { version: '21.2.14' });
  installPackage(root, '@angular/cdk', { version: '21.2.14' });
  installPackage(root, 'ngx-old', { version: '1.0.4' }, { 'index.metadata.json': '{}' });
  const project = new doctor.Project(root);
  const advice = await doctor.adviseDeps({ project, target: 22 });
  const steps = doctor.planDepCommands(advice, project, 22).filter((s) => s.step !== 'manual');
  assert.deepStrictEqual(steps.slice(0, 2).map((s) => s.step), ['uninstall', 'ng-update']);
  assert.match(steps[0].command, /^npm uninstall .*ngx-old/);
  assert.strictEqual(steps[1].command.split(' "')[0], 'npx ng update @angular/material@22', 'core and cli are already on 22');

  // Nothing behind: no ng update at all; Angular-peer bumps become plain installs.
  const done = doctor.planDepCommands([{ name: 'ngx-spinner', current: '14.0.0', action: 'upgrade', suggested: '^16.0.2', source: 'table', note: '' }],
    new doctor.Project(fixtureAt('ng16-app', '^22.2.3', (pkg) => { delete pkg.dependencies['@angular/material']; delete pkg.dependencies['@angular/cdk']; pkg.devDependencies['@angular/cli'] = '^22.2.2'; pkg.dependencies['ngx-spinner'] = '14.0.0'; })), 22);
  assert.deepStrictEqual(done.filter((s) => s.step !== 'manual').map((s) => s.command), ['npm install --save "ngx-spinner@^16.0.2"']);

  const out = [
    'Error: Package installation failed: extraneous: angular-cli-tmp-packages-XWDtp5@ D:\\app\\node_modules\\angular-cli-tmp-packages-XWDtp5',
    'invalid: rxjs@7.8.2 D:\\app\\node_modules\\rxjs',
    'Output: npm error code ELSPROBLEMS',
    'npm error extraneous: angular-cli-tmp-packages-XWDtp5@ D:\\app\\node_modules\\angular-cli-tmp-packages-XWDtp5',
    'npm error invalid: rxjs@7.8.2 D:\\app\\node_modules\\rxjs',
  ].join('\n');
  assert.deepStrictEqual(doctor.npmLsProblems(out), { extraneous: ['angular-cli-tmp-packages-XWDtp5'], invalid: ['rxjs@7.8.2'] });
  assert.strictEqual(doctor.npmLsProblems('npm error code ERESOLVE'), undefined);
  fs.mkdirSync(path.join(root, 'node_modules', 'angular-cli-tmp-packages-XWDtp5'));
  assert.deepStrictEqual(doctor.cliTempFolders(project).map((p) => path.basename(p)), ['angular-cli-tmp-packages-XWDtp5']);
  assert.match(advice.find((a) => a.name === 'node (runtime)').note, require('semver').satisfies(process.versions.node, doctor.requirementsFor(22).node) ? /^Fits\./ : /^Suggested: /);
});

test('strict --enable: fixes the errors strict would cause, then replaces "strict": false and drops false sub-flags', () => {
  const root = copyFixture('ng22-strict');
  fs.mkdirSync(path.join(root, 'node_modules/crypto-js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/crypto-js/package.json'), '{"name":"crypto-js","version":"4.2.0","main":"index.js"}');
  fs.writeFileSync(path.join(root, 'node_modules/crypto-js/index.js'), 'module.exports = {};');
  // Strict switched off, plus an explicit sub-flag that would override strict: true.
  fs.writeFileSync(path.join(root, 'tsconfig.json'),
    '{\n  "compilerOptions": { "target": "ES2022", "module": "ES2022", "moduleResolution": "node", "strict": false, "strictNullChecks": false, "noEmit": true, "skipLibCheck": true },\n  "include": ["src/**/*.ts"]\n}\n');
  assert.strictEqual(doctor.planStrictFixes(new doctor.Project(root)).fixes.length, 0, 'with strict off there is nothing to fix');
  const plan = doctor.planStrictFixes(new doctor.Project(root), { strict: true });
  assert.ok(plan.fixes.length > 0);
  assert.deepStrictEqual(plan.remaining, []);

  const { spawnSync } = require('child_process');
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli.js'), 'strict', '--enable', '--yes', '--project', root], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout, /tsconfig\.json: "strict": false → true, removed "strictNullChecks": false/);
  const ts = JSON.parse(read(root, 'tsconfig.json'));
  assert.strictEqual(ts.compilerOptions.strict, true);
  assert.ok(!('strictNullChecks' in ts.compilerOptions));
  assert.match(read(root, 'src/app/score.component.ts'), /bankarray!: any\[\];/);
  assert.strictEqual(doctor.planStrictFixes(new doctor.Project(root)).fixes.length, 0, 'compiles under strict now');

  // No "strict" anywhere: it is added to tsconfig.json.
  const fresh = copyFixture('ng16-app');
  const changes = (() => { const p = new doctor.Project(fresh); const c = doctor.enableStrict(p); p.flush(false); return c; })();
  assert.deepStrictEqual(changes, [{ file: 'tsconfig.json', changes: ['added "strict": true'] }]);
  assert.strictEqual(JSON.parse(read(fresh, 'tsconfig.json')).compilerOptions.strict, true);
});

test('strict --enable leaves tsconfig alone while errors remain (unless --force)', () => {
  const root = copyFixture('ng22-strict');
  fs.writeFileSync(path.join(root, 'tsconfig.json'),
    '{\n  "compilerOptions": { "target": "ES2022", "module": "ES2022", "moduleResolution": "node", "strict": false, "noEmit": true, "skipLibCheck": true },\n  "include": ["src/**/*.ts"]\n}\n');
  // crypto-js is not installed here and a hand-written error remains.
  fs.writeFileSync(path.join(root, 'src/app/bad.ts'), 'export function f(a) { return a.b; }\nexport const n: number = "x";\n');
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'dist', 'cli.js');
  let out = spawnSync(process.execPath, [cli, 'strict', '--enable', '--yes', '--project', root], { encoding: 'utf8' });
  assert.match(out.stdout, /Strict mode NOT turned on: \d+ error\(s\) still need a hand/);
  assert.strictEqual(JSON.parse(read(root, 'tsconfig.json')).compilerOptions.strict, false);
  out = spawnSync(process.execPath, [cli, 'strict', '--enable', '--force', '--yes', '--project', root], { encoding: 'utf8' });
  assert.match(out.stdout, /Strict mode is on with \d+ error\(s\) left \(--force\)/);
  assert.strictEqual(JSON.parse(read(root, 'tsconfig.json')).compilerOptions.strict, true);
});

test('npm "invalid" installs are found before ng update, and leftover CLI temp folders are removed', () => {
  const root = fixtureAt('ng16-app', null, (pkg) => Object.assign(pkg.dependencies, { jspdf: '1.5.3', 'jspdf-autotable': '3.8.4' }));
  installPackage(root, 'jspdf', { version: '1.5.3' });
  installPackage(root, 'jspdf-autotable', { version: '3.8.4', peerDependencies: { jspdf: '^2.5.1' } });
  installPackage(root, 'ok-lib', { version: '1.0.0', dependencies: { jspdf: '^1.5.0' } });
  installPackage(root, 'nested-lib', { version: '1.0.0', dependencies: { jspdf: '^3.0.0' } });
  installPackage(path.join(root, 'node_modules', 'nested-lib'), 'jspdf', { version: '3.0.0' });
  const inv = doctor.invalidInstalls(new doctor.Project(root));
  assert.deepStrictEqual(inv, [{ name: 'jspdf', installed: '1.5.3', requiredBy: [{ pkg: 'jspdf-autotable', version: '3.8.4', range: '^2.5.1', peer: true }] }],
    'satisfied ranges and nested copies are fine');
  const f = findingsOf(root, 16, 'deps/invalid-installed');
  assert.strictEqual(f[0].severity, 'warning');
  assert.match(f[0].message, /^jspdf@1\.5\.3 is invalid for npm: jspdf-autotable@3\.8\.4 wants \^2\.5\.1 \(peer\) → upgrade or uninstall jspdf-autotable$/);

  fs.mkdirSync(path.join(root, 'node_modules/angular-cli-tmp-packages-XWDtp5/node_modules'), { recursive: true });
  assert.strictEqual(findingsOf(root, 16, 'deps/cli-temp-folders').length, 1);
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['deps/cli-temp-folders'], dryRun: true });
  assert.ok(fs.existsSync(path.join(root, 'node_modules/angular-cli-tmp-packages-XWDtp5')), 'dry run keeps it');
  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['deps/cli-temp-folders'] });
  assert.ok(!fs.existsSync(path.join(root, 'node_modules/angular-cli-tmp-packages-XWDtp5')));
});

const POSSIBLY_UNDEFINED = [
  'declare function get(): Promise<{ data: any } | undefined>;',
  'declare const obs: { subscribe(fn: (v: { data: any } | undefined) => void): void };',
  'export async function load(): Promise<void> {',
  '  const res = await get();',
  "  console.log(res.data, res['data']);",
  '  let typed: { data: any } | undefined = await get();',
  '  console.log(typed?.data);',
  '  obs.subscribe(loandata => console.log(loandata.data));',
  '  obs.subscribe((r) => console.log(r.data));',
  '  try { await get(); } catch (err) { console.log(err.message); }',
  '  for (const x of [await get()]) console.log(x.data);',
  '}',
  '',
].join('\n');

test('strict: "possibly undefined" locals and callback parameters get `: any` (TS18048, TS18046)', () => {
  const root = copyFixture('ng22-strict');
  fs.writeFileSync(path.join(root, 'src/app/loan.ts'), POSSIBLY_UNDEFINED);
  const plan = doctor.planStrictFixes(new doctor.Project(root));
  const mine = plan.fixes.filter((f) => f.file === 'src/app/loan.ts');
  assert.deepStrictEqual(mine.map((f) => [f.kind, f.code, f.name]), [
    ['possibly-undefined', 18048, 'res'],
    ['possibly-undefined', 18048, 'loandata'],
    ['possibly-undefined', 18048, 'r'],
    ['possibly-undefined', 18046, 'err'],
  ], 'one fix per declaration; explicitly typed locals are left alone');
  const out = plan.output.get('src/app/loan.ts');
  assert.match(out, /const res: any = await get\(\);/);
  assert.match(out, /let typed: \{ data: any \} \| undefined = await get\(\);/);
  assert.match(out, /obs\.subscribe\(\(loandata: any\) => console\.log\(loandata\.data\)\);/);
  assert.match(out, /obs\.subscribe\(\(r: any\) => /);
  assert.match(out, /catch \(err: any\)/);
  assert.match(out, /for \(const x of \[await get\(\)\]\)/, 'for-of variables cannot be annotated');
  assert.deepStrictEqual(plan.remaining.filter((r) => r.file === 'src/app/loan.ts').map((r) => r.line), [11]);
});

test('types --mode nullable only annotates what strictNullChecks calls possibly undefined', () => {
  const root = copyFixture('ng22-app');
  fs.writeFileSync(path.join(root, 'src/app/loan.ts'), POSSIBLY_UNDEFINED);
  const project = new doctor.Project(root);
  const plan = doctor.planTypes(project, { mode: 'nullable' });
  assert.deepStrictEqual(plan.annotations.map((a) => `${a.file}:${a.name}`),
    ['src/app/loan.ts:res', 'src/app/loan.ts:loandata', 'src/app/loan.ts:r', 'src/app/loan.ts:err'],
    'the strict: false fixture is checked as if strictNullChecks were on; nothing else is annotated');
  doctor.applyTypePlan(project, plan);
  project.flush(false);
  assert.match(read(root, 'src/app/loan.ts'), /obs\.subscribe\(\(loandata: any\) =>/);
  assert.match(read(root, 'src/app/user-store.ts'), /count = 0;/);
});

test('finalize: every fix for the installed version, subscribe → { next, error }, types, cache, then what is left', () => {
  const root = copyFixture('ng22-app');
  fs.writeFileSync(path.join(root, 'src/app/loan.ts'), POSSIBLY_UNDEFINED);
  fs.writeFileSync(path.join(root, 'src/app/list.ts'), [
    'declare const api: { get(): { subscribe(...a: any[]): void } };',
    'export class List {',
    '  rows: any;',
    '  init(): void {',
    '    api.get().subscribe((res: any) => { this.rows = res; }, (err: any) => console.log(err));',
    '    api.get().subscribe((res: any) => this.rows = res);',
    '  }',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/styles.scss'), '@import "~bootstrap/scss/bootstrap";\n');
  fs.mkdirSync(path.join(root, '.angular/cache/22'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app/list.html'), '<mat-form-field appearance="legacy"><mat-select [(value)]="v"></mat-select></mat-form-field>\n');
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'dist', 'cli.js');

  const dry = spawnSync(process.execPath, [cli, 'finalize', '--offline', '--dry-run', '--yes', '--project', root], { encoding: 'utf8' });
  assert.match(dry.stdout, /\[1\/5\] Dependencies compatible with Angular 22/);
  assert.match(dry.stdout, /Would apply: .*styles\/tilde-imports/);
  assert.match(dry.stdout, /Would clear \.angular\/cache/);
  assert.match(read(root, 'src/styles.scss'), /~bootstrap/, 'dry run changes nothing');
  assert.ok(fs.existsSync(path.join(root, '.angular/cache')));

  const out = spawnSync(process.execPath, [cli, 'finalize', '--skip-deps', '--yes', '--project', root], { encoding: 'utf8' });
  assert.match(out.stdout, /Applied: .*styles\/tilde-imports.*rxjs\/subscribe-observer-style/);
  assert.match(out.stdout, /Analysing with mode "nullable"/);
  assert.match(out.stdout, /\[5\/5\] What is left/);
  assert.strictEqual(read(root, 'src/styles.scss'), '@import "bootstrap/scss/bootstrap";\n');
  const list = read(root, 'src/app/list.ts');
  assert.match(list, /subscribe\(\{ next: \(res: any\) => \{ this\.rows = res; \}, error: \(err: any\) => console\.log\(err\) \}\)/);
  assert.match(list, /subscribe\(\{ next: \(res: any\) => this\.rows = res \}\)/);
  assert.match(read(root, 'src/app/loan.ts'), /const res: any = await get\(\);/);
  assert.strictEqual(read(root, 'src/app/list.html'), '<mat-form-field><mat-select hideSingleSelectionIndicator [(value)]="v"></mat-select></mat-form-field>\n');
  assert.ok(!fs.existsSync(path.join(root, '.angular/cache')));
});

test('MDC design: old class overrides are renamed in stylesheets and inline styles; literal and unmapped classes are kept', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/asset.component.scss'), [
    '::ng-deep .mat-form-field-infix { padding: 0; }',
    '.mat-select-arrow-wrapper { transform: none; }',
    '.mat-select-panel .mat-option { height: 32px; }',
    '.mat-select-search-inner { top: 0; }',
    '.mat-form-field-label-wrapper { top: -1em; }',
    '.mat-card { padding: 8px; }',
    '.mat-tooltip-panel { color: red; }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/app/asset.component.ts'), [
    "import { Component } from '@angular/core';",
    '@Component({',
    "  selector: 'app-asset',",
    "  template: '<div class=\"mat-card\"></div>',",
    '  styles: [`.mat-form-field-wrapper { padding-bottom: 0; }`, `.mat-option-text { font-size: 12px; }`],',
    '})',
    'export class AssetComponent {}',
    '',
  ].join('\n'));
  const f = findingsOf(root, 22, 'material/mdc-style-overrides').filter((x) => x.file.startsWith('src/app/asset'));
  assert.deepStrictEqual(f.map((x) => [x.file, x.line, x.fixable]), [
    ['src/app/asset.component.scss', 1, true], ['src/app/asset.component.scss', 2, true], ['src/app/asset.component.scss', 3, true],
    ['src/app/asset.component.scss', 3, true], ['src/app/asset.component.scss', 5, false], ['src/app/asset.component.scss', 6, false],
    ['src/app/asset.component.ts', 5, true], ['src/app/asset.component.ts', 5, true],
  ], 'ngx-mat-select-search and .mat-tooltip-panel are not old internals');
  assert.match(f[5].message, /kept: your templates use the class themselves/);
  assert.match(f[4].message, /no 1:1 MDC class/);

  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['material/mdc-style-overrides'] });
  assert.strictEqual(read(root, 'src/app/asset.component.scss'), [
    '::ng-deep .mat-mdc-form-field-infix { padding: 0; }',
    '.mat-mdc-select-arrow-wrapper { transform: none; }',
    '.mat-mdc-select-panel .mat-mdc-option { height: 32px; }',
    '.mat-select-search-inner { top: 0; }',
    '.mat-form-field-label-wrapper { top: -1em; }',
    '.mat-card { padding: 8px; }',
    '.mat-tooltip-panel { color: red; }',
    '',
  ].join('\n'));
  assert.match(read(root, 'src/app/asset.component.ts'), /styles: \[`\.mat-mdc-text-field-wrapper \{ padding-bottom: 0; \}`, `\.mdc-list-item__primary-text \{ font-size: 12px; \}`\]/);
  assert.match(read(root, 'src/app/asset.component.ts'), /class="mat-card"/, 'templates are not touched');

  // Still on the legacy components: their DOM keeps the old classes, so nothing is renamed.
  fs.writeFileSync(path.join(root, 'src/app/legacy.ts'), "import { MatLegacySelectModule } from '@angular/material/legacy-select';\n");
  fs.writeFileSync(path.join(root, 'src/app/other.scss'), '.mat-option { color: red; }\n');
  assert.strictEqual(findingsOf(root, 22, 'material/mdc-style-overrides').find((x) => x.file === 'src/app/other.scss').fixable, false);
});

test('MDC design: removed form-field appearances, the selection check mark and inputs inside mat-option', () => {
  const root = copyFixture('ng16-app');
  fs.writeFileSync(path.join(root, 'src/app/asset.component.html'), [
    '<mat-form-field appearance="legacy"><mat-label>Customer Name</mat-label><input matInput></mat-form-field>',
    '<mat-form-field appearance="outline" floatLabel="never"><mat-select formControlName="model">',
    '  <mat-option><input placeholder="Search" (keyup)="filter($event)"></mat-option>',
    '  <mat-option *ngFor="let m of models" [value]="m">{{ m }}</mat-option>',
    '</mat-select></mat-form-field>',
    '<mat-form-field [appearance]="\'standard\'"><mat-select multiple><mat-option value="a">A</mat-option></mat-select></mat-form-field>',
    '<mat-form-field><mat-select hideSingleSelectionIndicator><mat-option><ngx-mat-select-search></ngx-mat-select-search></mat-option></mat-select></mat-form-field>',
    '<input [matAutocomplete]="auto"><mat-autocomplete #auto="matAutocomplete"></mat-autocomplete>',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/app/form-defaults.ts'), "export const providers = [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'legacy', floatLabel: 'never' } }];\n");

  const appearance = findingsOf(root, 22, 'material/form-field-appearance');
  assert.deepStrictEqual(appearance.map((x) => [x.file, x.line]), [
    ['src/app/asset.component.html', 1], ['src/app/asset.component.html', 2], ['src/app/asset.component.html', 6],
    ['src/app/form-defaults.ts', 1], ['src/app/form-defaults.ts', 1],
  ]);
  assert.match(appearance[3].message, /appearance "legacy" no longer exists → appearance: 'fill'/);
  const option = findingsOf(root, 22, 'material/input-in-option');
  assert.deepStrictEqual(option.map((x) => x.line), [3], 'ngx-mat-select-search is the supported way');
  const indicator = findingsOf(root, 22, 'material/select-selection-indicator');
  assert.strictEqual(indicator[0].severity, 'info');
  assert.match(indicator[0].message, /^2 single-selection mat-select\/mat-autocomplete show a ✓/);

  doctor.fix({ project: new doctor.Project(root), mode: 'current' });
  let html = read(root, 'src/app/asset.component.html');
  assert.match(html, /^<mat-form-field><mat-label>Customer Name/);
  assert.match(html, /<mat-form-field appearance="outline"><mat-select formControlName="model">/);
  assert.match(html, /<mat-form-field><mat-select multiple>/);
  assert.match(html, /<mat-select formControlName="model">/, 'the check-mark rule is opt-in');
  assert.strictEqual(read(root, 'src/app/form-defaults.ts'), "export const providers = [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'fill', floatLabel: 'auto' } }];\n");

  doctor.fix({ project: new doctor.Project(root), mode: 'current', only: ['material/select-selection-indicator'] });
  html = read(root, 'src/app/asset.component.html');
  assert.match(html, /<mat-select hideSingleSelectionIndicator formControlName="model">/);
  assert.match(html, /<mat-select multiple>/);
  assert.match(html, /<mat-autocomplete hideSingleSelectionIndicator #auto="matAutocomplete">/);
  assert.strictEqual((html.match(/hideSingleSelectionIndicator/g) || []).length, 3);
});

test('ngx-mat-select-search: pre-MDC releases break the select panel at 15; Material 22 gets the latest, 9.x', () => {
  assert.strictEqual(doctor.knownBreaker('ngx-mat-select-search', '5.0.0', 15).suggested, '^7.0.0');
  assert.strictEqual(doctor.knownBreaker('ngx-mat-select-search', '5.0.0', 22).suggested, '^9.0.0');
  assert.strictEqual(doctor.knownBreaker('ngx-mat-select-search', '8.0.6', 22).suggested, '^9.0.0');
  assert.strictEqual(doctor.knownBreaker('ngx-mat-select-search', '7.0.6', 18), undefined);
  assert.strictEqual(doctor.knownBreaker('ngx-mat-select-search', '9.0.0', 22), undefined);
});
