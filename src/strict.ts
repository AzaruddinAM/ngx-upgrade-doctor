import * as ts from 'typescript';
import { Project } from './project';
import {
  Edit, anyAnnotationEdits, applyEdits, compilerOptions, createProgram, diagnosticCount, nullishDeclaration, sourceFiles, toAbs,
} from './typer';
import { removeJsonProp, setJsonOption } from './rules/helpers';

/**
 * definite-assignment — `name: T;` → `name!: T;` (TS2564, assigned later in ngOnInit, a subscribe, …)
 * null-as-any         — `x = null` → `x = null as any` (TS2322 for a null/undefined literal)
 * index-as-any        — `this[key]` → `(this as any)[key]` (TS7053, TS7015)
 * module-shim         — `declare module 'name';` for packages without types (TS7016)
 * possibly-undefined  — `const res = …` → `const res: any = …`, `res => …` → `(res: any) => …`
 *                       (TS18048/18047/18049/2531/2532/2533 possibly 'undefined'/'null', TS18046 catch variable 'unknown')
 */
export type StrictFixKind = 'definite-assignment' | 'null-as-any' | 'index-as-any' | 'module-shim' | 'possibly-undefined';

export interface StrictFix {
  file: string;
  line: number;
  code: number;
  kind: StrictFixKind;
  name: string;
}

export interface StrictPlan {
  fixes: StrictFix[];
  /** New file contents, keyed by workspace-relative path. */
  output: Map<string, string>;
  /** Files whose edits introduced new compiler errors and were dropped. */
  reverted: string[];
  /** Compiler errors left after the fixes; these need a hand. */
  remaining: Array<{ file?: string; line?: number; message: string }>;
  /** Packages declared in the shim; installing their @types package is the better fix. */
  modules: string[];
  shimFile?: string;
}

const NULL_ASSIGN = /^Type '(null|undefined)' is not assignable/;
const SHIM_FILES = ['src/typings.d.ts', 'src/untyped-modules.d.ts'];
const MAX_ROUNDS = 3;

function innermost(sf: ts.SourceFile, pos: number): ts.Node {
  let found: ts.Node = sf;
  const visit = (n: ts.Node): void => {
    if (n.getStart(sf) <= pos && pos < n.end) {
      found = n;
      n.forEachChild(visit);
    }
  };
  sf.forEachChild(visit);
  return found;
}

function isNullish(e: ts.Expression): boolean {
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
}

function isAssignment(n: ts.Node): n is ts.BinaryExpression {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** The literal `null`/`undefined` a TS2322 at `pos` complains about, if that is all it is. */
function nullishValue(sf: ts.SourceFile, pos: number): ts.Expression | undefined {
  for (let n: ts.Node | undefined = innermost(sf, pos); n && n !== sf; n = n.parent) {
    if (isAssignment(n) && n.left.getStart(sf) <= pos && pos < n.left.end) {
      let value = n.right;
      while (isAssignment(value)) value = value.right;
      return isNullish(value) ? value : undefined;
    }
    if ((ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n)) && n.name.getStart(sf) <= pos && pos < n.name.end) {
      return n.initializer && isNullish(n.initializer) ? n.initializer : undefined;
    }
    if (ts.isStatement(n) || ts.isClassElement(n)) return undefined;
  }
  return undefined;
}

function elementAccessAt(sf: ts.SourceFile, pos: number): ts.ElementAccessExpression | undefined {
  for (let n: ts.Node | undefined = innermost(sf, pos); n && n !== sf; n = n.parent) {
    if (ts.isElementAccessExpression(n) && (n.getStart(sf) === pos || n.argumentExpression.getStart(sf) === pos)) return n;
    if (ts.isStatement(n)) return undefined;
  }
  return undefined;
}

interface RoundResult {
  fixes: StrictFix[];
  edits: Map<string, Edit[]>;
  modules: Set<string>;
}

function fixesFor(program: ts.Program, project: Project, files: string[]): RoundResult {
  const fixes: StrictFix[] = [];
  const edits = new Map<string, Edit[]>();
  const modules = new Set<string>();
  for (const file of files) {
    const sf = program.getSourceFile(toAbs(project, file));
    if (!sf) continue;
    const list: Edit[] = [];
    const checker = program.getTypeChecker();
    const seen = new Set<number>();
    const add = (d: ts.Diagnostic, kind: StrictFixKind, name: string, ...e: Edit[]): void => {
      if (seen.has(e[0].pos)) return;
      seen.add(e[0].pos);
      list.push(...e);
      fixes.push({ file, line: sf.getLineAndCharacterOfPosition(d.start!).line + 1, code: d.code, kind, name });
    };
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (d.start === undefined) continue;
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      const nullish = nullishDeclaration(checker, sf, d);
      if (nullish) {
        add(d, 'possibly-undefined', nullish.name.getText(sf), ...anyAnnotationEdits(nullish, sf));
      } else if (d.code === 2564) {
        const prop = innermost(sf, d.start).parent;
        if (prop && ts.isPropertyDeclaration(prop) && !prop.questionToken && !prop.exclamationToken) {
          add(d, 'definite-assignment', prop.name.getText(sf), { pos: prop.name.end, text: '!', order: 0 });
        }
      } else if (d.code === 2322 && NULL_ASSIGN.test(message)) {
        const value = nullishValue(sf, d.start);
        if (value) add(d, 'null-as-any', value.getText(sf), { pos: value.end, text: ' as any', order: 0 });
      } else if (d.code === 7053 || d.code === 7015) {
        const access = elementAccessAt(sf, d.start);
        if (access) {
          const target = access.expression;
          add(d, 'index-as-any', access.getText(sf).slice(0, 60),
            { pos: target.getStart(sf), text: '(', order: 0 }, { pos: target.end, text: ' as any)', order: 0 });
        }
      } else if (d.code === 7016) {
        const node = innermost(sf, d.start);
        if (ts.isStringLiteral(node)) {
          modules.add(node.text);
          fixes.push({ file, line: sf.getLineAndCharacterOfPosition(d.start).line + 1, code: d.code, kind: 'module-shim', name: node.text });
        }
      }
    }
    if (list.length) edits.set(file, list);
  }
  return { fixes, edits, modules };
}

/**
 * Fixes the errors `strict: true` reports in code written before strict mode, keeping runtime behaviour:
 * every edit is a type-level assertion. Verified by recompiling — a file that would gain errors is left untouched.
 */
/** The individual flags `strict` turns on; an explicit `false` for any of them overrides `strict: true`. */
export const STRICT_FAMILY = [
  'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization',
  'noImplicitThis', 'alwaysStrict', 'useUnknownInCatchVariables', 'strictBuiltinIteratorReturn',
];

/**
 * `strict`: type-check as if the tsconfig said `"strict": true` (and no strict flag was turned off), to plan
 * the fixes before `enableStrict` flips the tsconfig.
 */
export function planStrictFixes(project: Project, opts: { includeSpecs?: boolean; strict?: boolean } = {}): StrictPlan {
  const files = sourceFiles(project, opts.includeSpecs !== false);
  const shimFile = SHIM_FILES.find((f) => project.exists(f)) || SHIM_FILES[SHIM_FILES.length - 1];
  const declarations = project.files('.d.ts');
  if (!declarations.includes(shimFile)) declarations.push(shimFile);
  const rootNames = [...files, ...declarations].map((f) => toAbs(project, f));
  const options = compilerOptions(project);
  if (opts.strict) {
    for (const flag of STRICT_FAMILY) delete (options as Record<string, unknown>)[flag];
    options.strict = true;
  }

  const initial = createProgram(project, rootNames, options);
  const output = new Map<string, string>();
  const fixes: StrictFix[] = [];
  const modules = new Set<string>();
  let program = initial;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = fixesFor(program, project, files);
    const newModules = [...r.modules].filter((m) => !modules.has(m));
    if (!r.edits.size && !newModules.length) break;
    for (const [file, list] of r.edits) output.set(file, applyEdits(output.get(file) ?? project.read(file), list));
    for (const m of newModules) modules.add(m);
    fixes.push(...r.fixes);
    if (newModules.length) {
      const existing = output.get(shimFile) ?? (project.exists(shimFile) ? project.read(shimFile) : '');
      const lines = newModules.map((m) => `declare module '${m}';`).filter((l) => !existing.includes(l));
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      if (lines.length) output.set(shimFile, `${existing}${sep}${lines.join('\n')}\n`);
    }
    program = createProgram(project, rootNames, options, output, program);
  }

  // Verify: drop files where the edits add errors.
  const reverted: string[] = [];
  for (const file of [...output.keys()]) {
    if (file === shimFile) continue;
    const abs = toAbs(project, file);
    if (diagnosticCount(program, abs) > diagnosticCount(initial, abs)) {
      output.delete(file);
      reverted.push(file);
    }
  }
  if (reverted.length) program = createProgram(project, rootNames, options, output, program);

  const remaining: StrictPlan['remaining'] = [];
  for (const file of files) {
    const sf = program.getSourceFile(toAbs(project, file));
    if (!sf) continue;
    for (const d of program.getSemanticDiagnostics(sf)) {
      const message = `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      remaining.push({ file, line: d.start === undefined ? undefined : sf.getLineAndCharacterOfPosition(d.start).line + 1, message });
    }
  }
  return {
    fixes: fixes.filter((f) => (f.kind === 'module-shim' ? output.has(shimFile) : output.has(f.file))),
    output,
    reverted,
    remaining,
    modules: [...modules],
    shimFile: output.has(shimFile) ? shimFile : undefined,
  };
}

/** Writes a plan into the project (in memory; call project.flush to save). */
export function applyStrictPlan(project: Project, plan: StrictPlan): void {
  for (const [file, text] of plan.output) project.write(file, text);
}

export interface StrictConfigChange {
  file: string;
  /** What changed in that tsconfig, for the report. */
  changes: string[];
}

/**
 * Turns strict mode on in the workspace tsconfigs: every `"strict": false` becomes `true` (or `"strict": true` is
 * added to tsconfig.json when no file sets it), and explicit `false` strict-family flags are removed so they
 * stop overriding it. Writes into the project (in memory).
 */
export function enableStrict(project: Project): StrictConfigChange[] {
  const files = project.files('.json').filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f));
  const out: StrictConfigChange[] = [];
  let declared = false;
  for (const file of files) {
    let text = project.read(file);
    const changes: string[] = [];
    if (/"strict"\s*:/.test(text)) declared = true;
    if (/"strict"\s*:\s*false/.test(text)) {
      text = text.replace(/("strict"\s*:\s*)false/, '$1true');
      changes.push('"strict": false → true');
    }
    for (const flag of STRICT_FAMILY) {
      if (new RegExp(`"${flag}"\\s*:\\s*false`).test(text)) {
        text = removeJsonProp(text, flag, 'false');
        changes.push(`removed "${flag}": false`);
      }
    }
    if (changes.length) {
      project.write(file, text);
      out.push({ file, changes });
    }
  }
  if (!declared && project.exists('tsconfig.json')) {
    project.write('tsconfig.json', setJsonOption(project.read('tsconfig.json'), 'compilerOptions', 'strict', 'true'));
    out.push({ file: 'tsconfig.json', changes: ['added "strict": true'] });
  }
  return out;
}
