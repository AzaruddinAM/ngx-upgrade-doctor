import * as fs from 'fs';
import { builtinModules } from 'module';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import { Project, lineOf } from '../project';
import { requirementsFor, suggestedNode } from '../versions';
import { configFiles, importSpecifiers, isBuildFile, sourceRoots, tsFiles } from './helpers';
import { Rule, RawFinding } from './types';

/** Checks that run on every hop: Node, TypeScript, RxJS and zone.js ranges. */
export const envRules: Rule[] = [
  {
    id: 'env/node-version',
    hop: 'every hop',
    title: 'Node.js version must match the Angular CLI requirement',
    since: 6,
    removedIn: 6,
    hint: 'Install a matching Node with nvm (nvm install <version> && nvm use <version>). Keep one Node per hop if needed.',
    docs: 'https://angular.dev/reference/versions',
    check({ version }) {
      const req = requirementsFor(version);
      const node = process.versions.node;
      if (!req || semver.satisfies(node, req.node)) return [];
      return [{ message: nodeVersionMessage(node, req.node, version, nvmInstalledVersions()) }];
    },
  },
  {
    id: 'env/typescript-version',
    hop: 'every hop',
    title: 'TypeScript version must match the Angular compiler',
    since: 6,
    deprecatedIn: 6,
    hint: '`ng update @angular/core@<N>` usually bumps TypeScript. If it does not: npm i -D typescript@"<range>".',
    check({ project, version, mode }) {
      return rangeCheck(project.versionOf('typescript'), requirementsFor(version)?.typescript, 'typescript', version, mode);
    },
  },
  {
    id: 'env/rxjs-version',
    hop: 'every hop',
    title: 'RxJS version must be supported',
    since: 6,
    deprecatedIn: 6,
    hint: 'npm i rxjs@"<range>". Moving to RxJS 7 needs deep imports and rxjs-compat cleaned up first (rxjs/deep-imports auto-fixes the simple patch imports), and Subject.next() calls given a value (rxjs/subject-next-without-value).',
    check({ project, version, mode }) {
      const out = rangeCheck(project.versionOf('rxjs'), requirementsFor(version)?.rxjs, 'rxjs', version, mode);
      // From v22 Angular's peerDependencies exclude RxJS 6: npm install fails, so it blocks the hop.
      return version >= 22 ? out.map((f) => ({ ...f, severity: 'error' as const })) : out;
    },
  },
  {
    id: 'env/zone-version',
    hop: 'every hop',
    title: 'zone.js version must be supported',
    since: 6,
    deprecatedIn: 6,
    hint: '`ng update` normally bumps zone.js. Otherwise npm i zone.js@"<range>".',
    check({ project, version, mode }) {
      return rangeCheck(project.versionOf('zone.js'), requirementsFor(version)?.zone, 'zone.js', version, mode);
    },
  },
  {
    id: 'deps/missing-packages',
    hop: 'every hop',
    title: 'Imports of packages that are not in package.json',
    since: 6,
    removedIn: 6,
    hint: 'npm install the package (pick a version that supports your Angular major — `ngx-upgrade-doctor deps --online`) or remove the import. For rxjs-compat, migrate the imports to "rxjs" / "rxjs/operators" rather than reinstalling it.',
    check: ({ project }) => missingPackageImports(project),
  },
];

/** "Node 22.1.0 is outside ... Supported: Node 18 (>=18.13.0), 20 (>=20.9.0); Node 21+ is not supported. Installed with nvm: ..." */
export function nodeVersionMessage(node: string, range: string, version: number, installed: string[]): string {
  const lows = range.split('||').map((r) => semver.minVersion(r.trim())).filter((v): v is semver.SemVer => !!v);
  const majors = lows.map((v) => `${v.major} (>=${v.version})`).join(', ');
  const newest = Math.max(...lows.map((v) => v.major));
  const usable = installed.filter((v) => semver.satisfies(v, range)).sort(semver.rcompare);
  // An open-ended range (">=26.0.0") has no newest unsupported major.
  const ceiling = semver.satisfies('999.0.0', range) ? '' : `; Node ${newest + 1}+ is not supported`;
  return `Node ${node} is outside the range Angular ${version} supports (${range}). `
    + `Supported: Node ${majors}${ceiling}. `
    + (usable.length
      ? `Installed with nvm and compatible: ${usable.join(', ')} — nvm use ${usable[0]}; or install ${suggestedNode(range).text}, which current tooling may need.`
      : `Suggested: ${suggestedNode(range).text}${installed.length ? ` (none of the nvm-installed ${installed.join(', ')} fit)` : ''}.`);
}

/** Node versions installed with nvm-windows (%NVM_HOME% or %APPDATA%\nvm) or nvm (~/.nvm/versions/node). */
export function nvmInstalledVersions(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const roots = [env.NVM_HOME, env.APPDATA && path.join(env.APPDATA, 'nvm'), env.NVM_DIR, path.join(home, '.nvm')]
    .filter((d): d is string => !!d)
    .flatMap((d) => [d, path.join(d, 'versions', 'node')]);
  const out = new Set<string>();
  for (const dir of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const v = semver.valid(e.replace(/^v/, ''));
      if (v) out.add(v);
    }
  }
  return [...out].sort(semver.rcompare);
}

const BUILTINS = new Set(builtinModules);

/** npm package name of a bare import specifier; undefined for relative paths and Node builtins. */
export function packageOf(specifier: string): string | undefined {
  if (/^(\.|\/|[a-z]+:)/i.test(specifier)) return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTINS.has(name) ? undefined : name;
}

/**
 * Bare imports whose package is neither declared in package.json nor installed in node_modules.
 * Commented-out imports are ignored; files `ng build` does not compile (e2e, specs) are warnings.
 */
export function missingPackageImports(project: Project): RawFinding[] {
  const deps = project.declaredDeps;
  const aliases = pathAliases(project);
  const roots = sourceRoots(project);
  const known = new Map<string, boolean>();
  const out: RawFinding[] = [];
  for (const file of tsFiles(project)) {
    const text = project.read(file);
    const inBuild = isBuildFile(project, file, roots);
    for (const { specifier, offset } of importSpecifiers(text)) {
      const pkg = packageOf(specifier);
      if (!pkg || aliases.some((matches) => matches(specifier))) continue;
      if (!known.has(pkg)) known.set(pkg, !!deps[pkg] || project.installedVersion(pkg) !== undefined);
      if (known.get(pkg)) continue;
      const how = pkg === 'rxjs-compat' ? ' — migrate to "rxjs" / "rxjs/operators" imports instead of reinstalling it' : '';
      const where = inBuild ? '' : ' (not part of the app build)';
      out.push({
        file, line: lineOf(text, offset), message: `'${specifier}': package ${pkg} is not in package.json${how}${where}`,
        ...(inBuild ? {} : { severity: 'warning' as const }),
      });
    }
  }
  return out;
}

/** Specifiers that tsconfig `paths` or `baseUrl` resolve to workspace files. */
function pathAliases(project: Project): Array<(spec: string) => boolean> {
  const out: Array<(spec: string) => boolean> = [];
  for (const file of configFiles(project).filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f))) {
    const opts = (project.readJson(file) || {}).compilerOptions || {};
    for (const key of Object.keys(opts.paths || {})) {
      const prefix = key.replace(/\*.*$/, '');
      out.push(key.includes('*') ? (s) => s.startsWith(prefix) : (s) => s === key);
    }
    if (typeof opts.baseUrl === 'string') {
      const base = path.posix.join(path.posix.dirname(file), opts.baseUrl);
      out.push((s) => {
        const first = path.posix.normalize(path.posix.join(base, s.split('/')[0]));
        return ['', '.ts', '.d.ts'].some((ext) => project.exists(first + ext));
      });
    }
  }
  return out;
}

function rangeCheck(installed: string | undefined, range: string | undefined, name: string, version: number, mode: string): RawFinding[] {
  if (!installed || !range || semver.satisfies(installed, range)) return [];
  const when = mode === 'target' ? `Angular ${version} needs` : `Angular ${version} expects`;
  return [{ file: 'package.json', message: `${name} ${installed} — ${when} ${range}.` }];
}
