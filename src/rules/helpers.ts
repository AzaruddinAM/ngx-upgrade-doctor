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
