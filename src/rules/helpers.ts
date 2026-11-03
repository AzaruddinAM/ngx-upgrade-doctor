import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Project, lineOf } from '../project';
import { RawFinding } from './types';

export const TS = ['.ts'];
export const STYLES = ['.scss', '.sass', '.css', '.less'];
export const TEMPLATES = ['.html'];

/** Source .ts files (no declaration files). */
export function tsFiles(project: Project): string[] {
  return project.files(...TS).filter((f) => !f.endsWith('.d.ts'));
}

function globalize(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
}

/** One finding per regex match across the given files. */
export function scanFiles(
  project: Project,
  files: string[],
  re: RegExp,
  message: string | ((m: RegExpExecArray) => string),
): RawFinding[] {
  const out: RawFinding[] = [];
  for (const file of files) {
    const text = project.read(file);
    const g = globalize(re);
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      out.push({ file, line: lineOf(text, m.index), message: typeof message === 'function' ? message(m) : message });
      if (m[0] === '') g.lastIndex++;
    }
  }
  return out;
}

/** One finding per file, with the number of matches. */
export function countPerFile(project: Project, files: string[], re: RegExp, message: (n: number) => string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const file of files) {
    const text = project.read(file);
    const matches = text.match(globalize(re));
    if (matches) out.push({ file, line: lineOf(text, text.search(re)), message: message(matches.length) });
  }
  return out;
}

export function transformFiles(project: Project, files: string[], transform: (text: string, file: string) => string): void {
  for (const file of files) project.write(file, transform(project.read(file), file));
}

/** Findings for a dependency declared in package.json. */
export function depFinding(project: Project, name: string, message: string): RawFinding[] {
  const range = project.declaredDeps[name];
  if (!range) return [];
  const text = project.read('package.json');
  const idx = text.indexOf(`"${name}"`);
  return [{ file: 'package.json', line: idx >= 0 ? lineOf(text, idx) : undefined, message: `${name}@${range}: ${message}` }];
}

export function removeDeps(project: Project, names: string[]): void {
  const pkg = project.pkg;
  let changed = false;
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const n of names) {
      if (n in deps) {
        delete deps[n];
        changed = true;
      }
    }
  }
  if (changed) project.writeJson('package.json', pkg);
}

export function addDevDep(project: Project, name: string, range: string): void {
  const pkg = project.pkg;
  if ((pkg.dependencies && pkg.dependencies[name]) || (pkg.devDependencies && pkg.devDependencies[name])) return;
  pkg.devDependencies = sortKeys({ ...(pkg.devDependencies || {}), [name]: range });
  project.writeJson('package.json', pkg);
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Removes `"key": <value>` from JSON text, keeping commas valid and formatting intact. */
export function removeJsonProp(text: string, key: string, valuePattern = '(?:"[^"]*"|true|false|\\d+|null)'): string {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const asLast = new RegExp(`,(\\s*)"${k}"\\s*:\\s*${valuePattern}(?=\\s*[}\\]])`);
  if (asLast.test(text)) return text.replace(asLast, '');
  return text.replace(new RegExp(`"${k}"\\s*:\\s*${valuePattern}\\s*,\\s*`), '');
}

/** Workspace JSON files that hold Angular/TS config. */
export function configFiles(project: Project): string[] {
  return project.files('.json').filter((f) => /(^|\/)(tsconfig[^/]*|angular|\.angular-cli)\.json$/.test(f));
}

/** Adds `line` at the top of a Sass file, after @charset and existing @use/@forward rules. */
export function ensureSassUse(text: string, line: string): string {
  if (text.includes(line)) return text;
  const lines = text.split('\n');
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^@(charset|use|forward)\b/.test(t)) insertAt = i + 1;
    else if (t !== '' && !t.startsWith('//')) break;
  }
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

/** Module specifiers a file imports (import/export from, import(), require()), skipping comments. */
export function importSpecifiers(text: string): Array<{ specifier: string; offset: number }> {
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => ({ specifier: f.fileName, offset: f.pos }));
}

/** Source roots of the workspace's application/library projects (angular.json `sourceRoot`, default `src`). */
export function sourceRoots(project: Project): string[] {
  const ws = project.readJson('angular.json') || project.readJson('.angular-cli.json') || {};
  const roots = Object.values<any>(ws.projects || {})
    .map((p) => p && typeof p.sourceRoot === 'string' ? p.sourceRoot.replace(/\/+$/, '') : undefined)
    .filter((r): r is string => !!r);
  return roots.length ? roots : ['src'];
}

/** Whether a .ts file is compiled by `ng build`: inside a source root, and not a spec or test entry file. */
export function isBuildFile(project: Project, file: string, roots = sourceRoots(project)): boolean {
  if (/\.spec\.ts$|(^|\/)test\.ts$/.test(file)) return false;
  return roots.some((r) => file.startsWith(`${r}/`));
}

/** An installed package built for View Engine: *.metadata.json next to package.json, or rewritten by ngcc. */
export function isViewEngineBuild(project: Project, name: string): boolean {
  const dir = path.join(project.root, 'node_modules', name);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!pkg.__processed_by_ivy_ngcc__ || fs.readdirSync(dir).some((f) => f.endsWith('.metadata.json'));
  } catch {
    return false;
  }
}

export interface MetadataArray {
  /** `NgModule`, `Component`, `Directive`, `Pipe` or `configureTestingModule`. */
  owner: string;
  /** `imports`, `declarations`, `providers`, `exports`, ... */
  prop: string;
  elements: ts.Expression[];
  source: ts.SourceFile;
}

const METADATA_OWNERS = new Set(['NgModule', 'Component', 'Directive', 'Pipe', 'configureTestingModule']);

/** Array literals in @NgModule/@Component/... metadata and TestBed.configureTestingModule({...}), from the AST. */
export function metadataArrays(file: string, text: string): MetadataArray[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: MetadataArray[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const owner = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const arg = node.arguments[0];
      if (METADATA_OWNERS.has(owner) && arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ts.isArrayLiteralExpression(p.initializer)) {
            out.push({ owner, prop: p.name.text, elements: [...p.initializer.elements], source });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** 1-based line of an AST node. */
export function nodeLine(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Replaces dependency `from` with `to@range` in the same package.json section. */
export function swapDep(project: Project, from: string, to: string, range: string): void {
  const pkg = project.pkg;
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section];
    if (!deps || !(from in deps)) continue;
    delete deps[from];
    pkg[section] = sortKeys({ ...deps, [to]: range });
    project.writeJson('package.json', pkg);
    return;
  }
}

/**
 * Inserts `"key": <raw JSON>` at the top of the `section` object ("compilerOptions", "angularCompilerOptions")
 * of a tsconfig, keeping comments and formatting; creates the section when it is missing.
 */
export function setJsonOption(text: string, section: string, key: string, raw: string): string {
  const head = new RegExp(`"${section}"\\s*:\\s*\\{`).exec(text);
  if (!head) {
    const root = text.indexOf('{');
    if (root < 0) return text;
    const rest = text.slice(root + 1);
    const comma = /^\s*\}/.test(rest) ? '' : ',';
    return `${text.slice(0, root + 1)}\n  "${section}": {\n    "${key}": ${raw}\n  }${comma}${rest}`;
  }
  const at = head.index + head[0].length;
  const rest = text.slice(at);
  const indent = (/\n([ \t]+)"/.exec(rest) || [, '    '])[1];
  const empty = /^\s*\}/.test(rest);
  return `${text.slice(0, at)}\n${indent}"${key}": ${raw}${empty ? '\n' : ','}${empty ? rest.replace(/^\s*/, '') : rest}`;
}

/** A JSON value pattern for removeJsonProp: an object nested at most two levels deep. */
export const JSON_OBJECT = '\\{(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*\\}';

/** tsconfig files of the workspace (tsconfig*.json anywhere). */
export function tsconfigFiles(project: Project): string[] {
  return configFiles(project).filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f));
}

/** Merged compilerOptions of a tsconfig and the relative files it `extends`, closest first wins. */
export function effectiveCompilerOptions(project: Project, file: string, seen = new Set<string>()): Record<string, any> {
  if (seen.has(file) || !project.exists(file)) return {};
  seen.add(file);
  const json = project.readJson(file) || {};
  const ext = typeof json.extends === 'string' && json.extends.startsWith('.')
    ? effectiveCompilerOptions(project, path.posix.normalize(path.posix.join(path.posix.dirname(file), json.extends)), seen)
    : {};
  return { ...ext, ...(json.compilerOptions || {}) };
}

/** Build options of every application in angular.json (`architect.build.options`), with the builder name. */
export function buildTargets(project: Project): Array<{ name: string; builder: string; options: Record<string, any>; configurations: Record<string, any> }> {
  const ws = project.readJson('angular.json') || {};
  return Object.entries<any>(ws.projects || {})
    .map(([name, p]) => ({ name, build: p && (p.architect || p.targets || {}).build }))
    .filter((x) => x.build)
    .map((x) => ({ name: x.name, builder: String(x.build.builder || ''), options: x.build.options || {}, configurations: x.build.configurations || {} }));
}

/** esbuild-based `application` builder (v17+), as opposed to the webpack `browser` builder. */
export function usesApplicationBuilder(project: Project): boolean {
  return buildTargets(project).some((t) => /:application$/.test(t.builder));
}

/**
 * Source files `ng build` compiles: everything reachable from the build entry points (main/browser,
 * polyfills) through relative imports, lazy import()s and tsconfig paths/baseUrl. Undefined when no
 * entry point can be found.
 */
export function buildGraph(project: Project): Set<string> | undefined {
  if (!graphCache.has(project)) graphCache.set(project, computeBuildGraph(project));
  return graphCache.get(project);
}

const graphCache = new WeakMap<Project, Set<string> | undefined>();

/** " (not in the build graph today; it fails as soon as it's imported)" for dead files, else ''. */
export function deadCodeNote(project: Project, file: string): string {
  const graph = buildGraph(project);
  return graph && !graph.has(file) ? " (not in the build graph today; it fails as soon as it's imported)" : '';
}

function computeBuildGraph(project: Project): Set<string> | undefined {
  const entries = new Set<string>();
  for (const t of buildTargets(project)) {
    for (const key of ['main', 'browser', 'polyfills']) {
      const v = t.options[key];
      for (const f of Array.isArray(v) ? v : [v]) if (typeof f === 'string' && f.endsWith('.ts') && project.exists(f)) entries.add(f);
    }
  }
  if (!entries.size && project.exists('src/main.ts')) entries.add('src/main.ts');
  if (!entries.size) return undefined;
  // Where bare specifiers can resolve: tsconfig baseUrl folders and paths targets.
  const bases: string[] = [];
  const mappings: Array<{ prefix: string; exact: boolean; targets: string[] }> = [];
  for (const file of tsconfigFiles(project)) {
    const opts = (project.readJson(file) || {}).compilerOptions || {};
    const dir = path.posix.dirname(file);
    const base = typeof opts.baseUrl === 'string' ? path.posix.normalize(path.posix.join(dir, opts.baseUrl)) : dir;
    if (typeof opts.baseUrl === 'string') bases.push(base);
    for (const [key, values] of Object.entries<string[]>(opts.paths || {})) {
      mappings.push({ prefix: key.replace(/\*$/, ''), exact: !key.endsWith('*'), targets: values.map((v) => path.posix.normalize(path.posix.join(base, v))) });
    }
  }
  const resolveFile = (p: string): string | undefined => {
    const clean = p.replace(/^\.\//, '');
    for (const c of [clean, `${clean}.ts`, `${clean}/index.ts`]) {
      if (c.endsWith('.ts') && project.exists(c)) return c;
    }
    return undefined;
  };
  const resolve = (from: string, spec: string): string | undefined => {
    if (spec.startsWith('.')) return resolveFile(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
    for (const m of mappings) {
      if (m.exact ? spec !== m.prefix : !spec.startsWith(m.prefix)) continue;
      for (const t of m.targets) {
        const hit = resolveFile(m.exact ? t : t.replace(/\*$/, spec.slice(m.prefix.length)));
        if (hit) return hit;
      }
    }
    for (const b of bases) {
      const hit = resolveFile(path.posix.join(b, spec));
      if (hit) return hit;
    }
    return undefined;
  };
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier } of importSpecifiers(project.read(file))) {
      const hit = resolve(file, specifier);
      if (hit && !seen.has(hit)) queue.push(hit);
    }
  }
  return seen;
}
