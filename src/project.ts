import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.angular', 'coverage', 'out-tsc', 'tmp', '.nx', '.cache', 'e2e-out',
]);

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * In-memory view of an Angular workspace. Rules read through it and fixes
 * write into it; nothing touches disk until `flush()`.
 */
export class Project {
  readonly root: string;
  private fileList?: string[];
  private cache = new Map<string, string>();
  private dirty = new Set<string>();

  constructor(root: string) {
    this.root = path.resolve(root);
    if (!fs.existsSync(path.join(this.root, 'package.json'))) {
      throw new Error(`No package.json found in ${this.root}. Run from your Angular workspace root or pass --project <dir>.`);
    }
  }

  get pkg(): PackageJson {
    return this.readJson<PackageJson>('package.json') || {};
  }

  /** All dependencies (prod + dev) declared in package.json. */
  get declaredDeps(): Record<string, string> {
    const pkg = this.pkg;
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  }

  /** Installed version of a package in node_modules, if any. */
  installedVersion(name: string): string | undefined {
    const pj = path.join(this.root, 'node_modules', name, 'package.json');
    if (!fs.existsSync(pj)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    } catch {
      return undefined;
    }
  }

  /** Version of a package: installed if present, otherwise the minimum of the declared range. */
  versionOf(name: string): string | undefined {
    const installed = this.installedVersion(name);
    if (installed) return installed;
    const range = this.declaredDeps[name];
    if (!range) return undefined;
    const min = semver.minVersion(range.replace(/^npm:.*@/, ''));
    return min ? min.version : undefined;
  }

  /** Current Angular major version, from @angular/core. */
  get angularMajor(): number | undefined {
    const v = this.versionOf('@angular/core');
    return v ? semver.major(v) : undefined;
  }

  exists(rel: string): boolean {
    return this.cache.has(rel) || fs.existsSync(path.join(this.root, rel));
  }

  read(rel: string): string {
    const hit = this.cache.get(rel);
    if (hit !== undefined) return hit;
    const content = fs.readFileSync(path.join(this.root, rel), 'utf8');
    this.cache.set(rel, content);
    return content;
  }

  readJson<T = any>(rel: string): T | undefined {
    if (!this.exists(rel)) return undefined;
    try {
      // tsconfig/angular.json may contain comments and trailing commas.
      return JSON.parse(stripJsonComments(this.read(rel)));
    } catch {
      return undefined;
    }
  }

  write(rel: string, content: string): void {
    if (this.exists(rel) && this.read(rel) === content) return;
    this.cache.set(rel, content);
    this.dirty.add(rel);
  }

  writeJson(rel: string, value: unknown): void {
    const original = this.exists(rel) ? this.read(rel) : '';
    const indent = /^( +|\t)"/m.exec(original);
    this.write(rel, JSON.stringify(value, null, indent ? indent[1] : 2) + '\n');
  }

  /** Workspace files (relative, forward slashes) with one of the given extensions. */
  files(...exts: string[]): string[] {
    if (!this.fileList) this.fileList = walk(this.root, '');
    return this.fileList.filter((f) => exts.some((e) => f.endsWith(e)));
  }

  get changedFiles(): string[] {
    return [...this.dirty].sort();
  }

  /** Writes changed files to disk (unless dryRun) and returns their paths. */
  flush(dryRun: boolean): string[] {
    const changed = this.changedFiles;
    if (!dryRun) {
      for (const rel of changed) {
        const abs = path.join(this.root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, this.cache.get(rel)!, 'utf8');
      }
      this.dirty.clear();
    }
    return changed;
  }
}

function walk(root: string, rel: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) out.push(...walk(root, child));
    } else if (e.isFile()) {
      out.push(child);
    }
  }
  return out;
}

export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
