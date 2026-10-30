import * as path from 'path';
import * as ts from 'typescript';
import { Project } from './project';
import { Rule } from './rules';
import { RuleResult } from './engine';

const TSC_RULE: Rule = {
  id: 'tsc/diagnostics',
  hop: 'current',
  title: 'TypeScript compiler errors',
  since: 0,
  hint: 'Template type errors only show up in `ng build`; run it too.',
  check: () => [],
};

/** Compiles the app tsconfig and returns its errors as a rule result. */
export function compileDiagnostics(project: Project): RuleResult | undefined {
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
