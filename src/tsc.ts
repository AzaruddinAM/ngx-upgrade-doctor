import * as path from 'path';
import * as bundledTs from 'typescript';
import { Project } from './project';
import { Rule } from './rules';
import { RuleResult } from './engine';

const TSC_RULE: Rule = {
  id: 'tsc/diagnostics',
  hop: 'current',
  title: 'TypeScript compiler errors',
  since: 0,
  hint: 'TypeScript errors in .ts files only. Template syntax errors are reported by template/parse-errors (needs @angular/compiler installed); template TYPE errors still only show up in `ng build`.',
  check: () => [],
};

type TypeScriptApi = typeof bundledTs;

export interface ProjectTypeScript {
  ts: TypeScriptApi;
  version: string;
  /** True when the project has no typescript installed and the doctor's own copy is used. */
  bundled: boolean;
}

/**
 * The project's own typescript (node_modules/typescript), so diagnostics match `ng build`;
 * newer lib typings in the bundled compiler report errors the project's compiler does not.
 */
export function projectTypeScript(root: string): ProjectTypeScript {
  try {
    const resolved = require.resolve('typescript', { paths: [root] });
    if (resolved !== require.resolve('typescript')) {
      const ts: TypeScriptApi = require(resolved);
      return { ts, version: ts.version, bundled: false };
    }
  } catch {
    // not installed in the project
  }
  return { ts: bundledTs, version: bundledTs.version, bundled: true };
}

/** Compiles the app tsconfig with the project's TypeScript and returns its errors as a rule result. */
export function compileDiagnostics(project: Project, ts: TypeScriptApi = projectTypeScript(project.root).ts): RuleResult | undefined {
  const candidates = ['tsconfig.app.json', 'src/tsconfig.app.json', 'tsconfig.json'];
  const rel = candidates.find((f) => project.exists(f));
  if (!rel) return undefined;
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(project.root, rel), { noEmit: true }, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  if (!parsed) return undefined;
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (!diags.length) return undefined;
  const findings = diags.map((d) => {
    const message = `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    if (!d.file || d.start === undefined) return { ruleId: TSC_RULE.id, severity: 'error' as const, fixable: false, message };
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    const file = path.relative(project.root, d.file.fileName).replace(/\\/g, '/');
    return { ruleId: TSC_RULE.id, severity: 'error' as const, fixable: false, message, file, line: line + 1 };
  });
  return { rule: TSC_RULE, severity: 'error', findings };
}
