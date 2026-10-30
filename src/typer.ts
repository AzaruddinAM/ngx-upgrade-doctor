import * as path from 'path';
import * as ts from 'typescript';
import { Project } from './project';

/**
 * infer        — annotate every declaration with the type TypeScript infers; `any` when it cannot be named safely.
 * any          — annotate every declaration with `any`.
 * implicit-any — only annotate what `noImplicitAny` reports, with `any`.
 */
export type TypeMode = 'infer' | 'any' | 'implicit-any';
export type DeclKind = 'parameter' | 'variable' | 'property' | 'return';

export interface TypeOptions {
  mode: TypeMode;
  includeSpecs?: boolean;
  /** Leave callbacks passed to calls (arr.map(x => ...)) alone — their types come from context. */
  skipCallbacks?: boolean;
}

export interface Annotation {
  file: string;
  line: number;
  kind: DeclKind;
  name: string;
  type: string;
}

export interface TypePlan {
  annotations: Annotation[];
  /** New file contents, keyed by workspace-relative path. */
  output: Map<string, string>;
  /** Files whose edits introduced new compiler errors and were dropped. */
  reverted: string[];
  /** Declarations left to inference because their type cannot be written in that file (infer mode). */
  skipped: number;
}

interface Candidate {
  node: ts.Node;
  kind: DeclKind;
  name: string;
  rest?: boolean;
}

interface Edit {
  pos: number;
  text: string;
  order: number;
}

const IMPLICIT_ANY_DECL = new Set([7005, 7006, 7008, 7019, 7022, 7031, 7034]);
const IMPLICIT_ANY_RETURN = new Set([7010, 7011, 7023, 7024]);

const TYPE_KEYWORDS = new Set([
  'any', 'unknown', 'never', 'void', 'undefined', 'null', 'string', 'number', 'boolean', 'bigint', 'symbol', 'object',
  'true', 'false', 'this', 'readonly', 'keyof', 'infer', 'extends', 'is', 'asserts',
]);

// ---------------------------------------------------------------------------
// Candidate collection (purely syntactic)
// ---------------------------------------------------------------------------

function isFunctionValue(node: ts.Node | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node));
}

function isCallback(fn: ts.Node): boolean {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const call = fn.parent as ts.Node;
  return (ts.isCallExpression(call) || ts.isNewExpression(call)) && (call.arguments || []).some((a) => a === fn);
}

function hasOpenParen(fn: ts.ArrowFunction, sf: ts.SourceFile): boolean {
  return fn.getChildren(sf).some((c) => c.kind === ts.SyntaxKind.OpenParenToken);
}

export function collectCandidates(sf: ts.SourceFile, opts: { skipCallbacks?: boolean } = {}): Candidate[] {
  const out: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node)) {
      const fn = node.parent;
      const isThis = ts.isIdentifier(node.name) && node.name.text === 'this';
      if (!node.type && !isThis && !ts.isIndexSignatureDeclaration(fn) && !(opts.skipCallbacks && isCallback(fn))) {
        out.push({ node, kind: 'parameter', name: node.name.getText(sf), rest: !!node.dotDotDotToken });
      }
    } else if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const inForInOf = list && list.parent && (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent));
      if (!node.type && ts.isIdentifier(node.name) && !inForInOf && !isFunctionValue(node.initializer)) {
        out.push({ node, kind: 'variable', name: node.name.text });
      }
    } else if (ts.isPropertyDeclaration(node)) {
      if (!node.type && !isFunctionValue(node.initializer)) out.push({ node, kind: 'property', name: node.name.getText(sf) });
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isGetAccessorDeclaration(node))
      && node.body && !node.type && !node.asteriskToken && !(opts.skipCallbacks && isCallback(node))
    ) {
      const fnName = node.name ? node.name.getText(sf)
        : ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)
          ? node.parent.name.getText(sf) : '<anonymous>';
      out.push({ node, kind: 'return', name: fnName });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function editsFor(c: Candidate, type: string, sf: ts.SourceFile, parenArrows: Set<ts.ArrowFunction>): Edit[] {
  const n = c.node;
  if (ts.isParameter(n)) {
    const fn = n.parent;
    if (ts.isArrowFunction(fn) && !hasOpenParen(fn, sf)) parenArrows.add(fn);
    return [{ pos: (n.questionToken || n.name).end, text: `: ${type}`, order: 0 }];
  }
  if (ts.isVariableDeclaration(n)) return [{ pos: (n.exclamationToken || n.name).end, text: `: ${type}`, order: 0 }];
  if (ts.isPropertyDeclaration(n)) return [{ pos: (n.questionToken || n.exclamationToken || n.name).end, text: `: ${type}`, order: 0 }];

  const fn = n as ts.FunctionLikeDeclaration;
  const close = fn.getChildren(sf).find((k) => k.kind === ts.SyntaxKind.CloseParenToken);
  if (close) return [{ pos: close.end, text: `: ${type}`, order: 1 }];
  // `x => ...` — parentheses get added around the single parameter.
  parenArrows.add(fn as ts.ArrowFunction);
  return [{ pos: fn.parameters[0].end, text: `: ${type}`, order: 1 }];
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = edits.slice().sort((a, b) => a.pos - b.pos || a.order - b.order);
  let out = '';
  let last = 0;
  for (const e of sorted) {
    out += text.slice(last, e.pos) + e.text;
    last = e.pos;
  }
  return out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

function inferredType(c: Candidate, checker: ts.TypeChecker): ts.Type | undefined {
  const n = c.node;
  if (ts.isParameter(n)) {
    const t = checker.getTypeAtLocation(n);
    return n.questionToken ? checker.getNonNullableType(t) : t;
  }
  if (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) {
    return checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(n.name));
  }
  const sig = checker.getSignatureFromDeclaration(n as ts.SignatureDeclaration);
  return sig ? checker.getReturnTypeOfSignature(sig) : undefined;
}

/** Prints a type only if every name in it resolves where it will be written. */
function nameableType(type: ts.Type, node: ts.Node, checker: ts.TypeChecker, fileScope: Set<string>): string | undefined {
  if (type.flags & ts.TypeFlags.Any) return undefined;
  const text = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  if (text.length > 120 || /import\(|[{}]|=>|typeof |unique symbol|\.\.\./.test(text)) return undefined;
  const scope = new Set(fileScope);
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    const tps = (p as any).typeParameters as ts.NodeArray<ts.TypeParameterDeclaration> | undefined;
    if (tps) for (const tp of tps) scope.add(tp.name.text);
  }
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const ids = withoutStrings.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) || [];
  return ids.every((id) => TYPE_KEYWORDS.has(id) || scope.has(id)) ? text : undefined;
}

// ---------------------------------------------------------------------------
// Program helpers
// ---------------------------------------------------------------------------

function compilerOptions(project: Project): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true, skipLibCheck: true,
  };
  const configPath = path.join(project.root, 'tsconfig.json');
  if (!ts.sys.fileExists(configPath)) return fallback;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  return parsed ? { ...parsed.options } : fallback;
}

function toAbs(project: Project, rel: string): string {
  return path.join(project.root, rel).replace(/\\/g, '/');
}

function createProgram(
  project: Project, rootNames: string[], options: ts.CompilerOptions, overrides?: Map<string, string>, oldProgram?: ts.Program,
): ts.Program {
  const host = ts.createCompilerHost(options, true);
  const norm = (f: string) => path.resolve(f).replace(/\\/g, '/').toLowerCase();
  const byAbs = new Map<string, string>();
  for (const [rel, text] of overrides || []) byAbs.set(norm(toAbs(project, rel)), text);
  const original = host.getSourceFile;
  host.getSourceFile = (fileName, lang, onError, shouldCreate) => {
    const text = byAbs.get(norm(fileName));
    return text !== undefined ? ts.createSourceFile(fileName, text, lang, true) : original.call(host, fileName, lang, onError, shouldCreate);
  };
  const readFile = host.readFile;
  host.readFile = (fileName) => {
    const text = byAbs.get(norm(fileName));
    return text !== undefined ? text : readFile.call(host, fileName);
  };
  return ts.createProgram({ rootNames, options: { ...options, noEmit: true }, host, oldProgram });
}

function diagnosticCount(program: ts.Program, absFile: string): number {
  const sf = program.getSourceFile(absFile);
  if (!sf) return 0;
  return program.getSyntacticDiagnostics(sf).length + program.getSemanticDiagnostics(sf).length;
}

function sourceFiles(project: Project, includeSpecs: boolean): string[] {
  return project.files('.ts').filter((f) => !f.endsWith('.d.ts') && (includeSpecs || !/\.spec\.ts$/.test(f)));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Untyped declarations per file, without type-checking (fast; used by `scan`). */
export function collectUntyped(project: Project): Array<{ file: string; count: number }> {
  const out: Array<{ file: string; count: number }> = [];
  for (const file of sourceFiles(project, false)) {
    const sf = ts.createSourceFile(file, project.read(file), ts.ScriptTarget.Latest, true);
    const count = collectCandidates(sf).length;
    if (count) out.push({ file, count });
  }
  return out;
}

/**
 * Computes the annotations for the workspace and verifies them by recompiling:
 * any file whose edits add compiler errors is left untouched.
 */
export function planTypes(project: Project, opts: TypeOptions): TypePlan {
  const files = sourceFiles(project, opts.includeSpecs !== false);
  const declarations = project.files('.d.ts');
  const rootNames = [...files, ...declarations].map((f) => toAbs(project, f));
  const options = compilerOptions(project);
  if (opts.mode === 'implicit-any') options.noImplicitAny = true;

  const program = createProgram(project, rootNames, options);
  const checker = program.getTypeChecker();
  const annotations: Annotation[] = [];
  let skipped = 0;
  const output = new Map<string, string>();

  for (const file of files) {
    const sf = program.getSourceFile(toAbs(project, file));
    if (!sf) continue;
    let candidates = collectCandidates(sf, opts);
    if (opts.mode === 'implicit-any') candidates = implicitAnyCandidates(program, sf, candidates);
    if (!candidates.length) continue;

    const fileScope = opts.mode === 'infer'
      ? new Set(checker.getSymbolsInScope(sf, ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias).map((s) => s.name))
      : new Set<string>();
    const parenArrows = new Set<ts.ArrowFunction>();
    const edits: Edit[] = [];
    for (const c of candidates) {
      let type: string | undefined;
      if (opts.mode === 'infer') {
        const t = inferredType(c, checker);
        type = t && nameableType(t, c.node, checker, fileScope);
        // A precise type that cannot be spelled here (typeof import(...), anonymous objects)
        // stays inferred — writing `any` over it would lose type safety.
        if (!type && t && !(t.flags & ts.TypeFlags.Any)) {
          skipped++;
          continue;
        }
      }
      if (!type) type = c.rest ? 'any[]' : 'any';
      edits.push(...editsFor(c, type, sf, parenArrows));
      annotations.push({ file, line: sf.getLineAndCharacterOfPosition(c.node.getStart(sf)).line + 1, kind: c.kind, name: c.name, type });
    }
    for (const fn of parenArrows) {
      const p = fn.parameters[0];
      edits.push({ pos: p.getStart(sf), text: '(', order: -1 }, { pos: p.end, text: ')', order: 0.5 });
    }
    if (edits.length) output.set(file, applyEdits(sf.text, edits));
  }

  // Verify: drop files where the annotations add errors.
  const reverted: string[] = [];
  if (output.size) {
    const after = createProgram(project, rootNames, options, output, program);
    for (const file of [...output.keys()]) {
      const abs = toAbs(project, file);
      if (diagnosticCount(after, abs) > diagnosticCount(program, abs)) {
        output.delete(file);
        reverted.push(file);
      }
    }
  }
  return { annotations: annotations.filter((a) => output.has(a.file)), output, reverted, skipped };
}

function implicitAnyCandidates(program: ts.Program, sf: ts.SourceFile, candidates: Candidate[]): Candidate[] {
  const picked = new Set<Candidate>();
  for (const d of program.getSemanticDiagnostics(sf)) {
    const isReturn = IMPLICIT_ANY_RETURN.has(d.code);
    if ((!isReturn && !IMPLICIT_ANY_DECL.has(d.code)) || d.start === undefined) continue;
    let best: Candidate | undefined;
    for (const c of candidates) {
      if ((c.kind === 'return') !== isReturn) continue;
      const start = c.node.getStart(sf);
      if (d.start >= start && d.start < c.node.end && (!best || c.node.end - start < best.node.end - best.node.getStart(sf))) best = c;
    }
    if (best) picked.add(best);
  }
  return candidates.filter((c) => picked.has(c));
}

/** Writes a plan into the project (in memory; call project.flush to save). */
export function applyTypePlan(project: Project, plan: TypePlan): void {
  for (const [file, text] of plan.output) project.write(file, text);
}
