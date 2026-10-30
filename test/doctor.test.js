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
  assert.match(svc, /import 'rxjs\/add\/operator\/catch';/, 'patch imports are left for a human');
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
  assert.match(cmds[0], /ng update @angular\/core@12 @angular\/cli@12 @angular\/material@12/);
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
  assert.strictEqual(steps[0].step, 'ng-update');
  assert.match(steps[0].command, /^npx ng update @angular\/core@12 @angular\/cli@12 @angular\/material@12 --allow-dirty$/);
  const save = of('install-save')[0].command;
  assert.match(save, /^npm install --save "@ng-bootstrap\/ng-bootstrap@\^10\.0\.0"/);
  assert.match(save, /"ngx-toastr@\^14\.3\.0"/);
  assert.doesNotMatch(save, /typescript|sass/);
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
    { name: '@angular/flex-layout', current: '14.0.0', action: 'replace', suggested: 'CSS flex/grid', source: 'rule', note: 'Deprecated.' },
  ];
  const steps = doctor.planDepCommands(advice, project, 15);
  assert.ok(!steps.some((s) => s.step === 'uninstall'));
  assert.strictEqual(steps.filter((s) => s.step === 'manual').length, 2);
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
