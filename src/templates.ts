import { pathToFileURL } from 'url';
import { Project } from './project';
import { Finding, Rule } from './rules';
import { RuleResult } from './engine';

const TEMPLATE_PARSE_RULE: Rule = {
  id: 'template/parse-errors',
  hop: 'current',
  title: 'Angular template parse errors',
  since: 0,
  hint: "Parsed with the project's own @angular/compiler (parseTemplate), the same parser `ng build` uses for NG5002 errors. Inline `template:` strings are not checked.",
  check: () => [],
};

// tsc compiles `import()` to require() for CommonJS output, which cannot load @angular/compiler (ESM only).
const importEsm = new Function('url', 'return import(url)') as (url: string) => Promise<any>;

export interface TemplateParseResult {
  result?: RuleResult;
  /** Which compiler was used, or why the check was skipped. */
  note: string;
}

/** Parses every .html template with the project's @angular/compiler and reports parse errors as blockers. */
export async function templateParseDiagnostics(project: Project): Promise<TemplateParseResult> {
  let resolved: string;
  try {
    resolved = require.resolve('@angular/compiler', { paths: [project.root] });
  } catch {
    return { note: 'Template parse check skipped: @angular/compiler is not installed in the project.' };
  }
  let compiler: any;
  try {
    compiler = await importEsm(pathToFileURL(resolved).href);
  } catch (e) {
    return { note: `Template parse check skipped: could not load @angular/compiler (${(e as Error).message.split('\n')[0]}).` };
  }
  if (typeof compiler.parseTemplate !== 'function') return { note: 'Template parse check skipped: this @angular/compiler has no parseTemplate().' };
  const findings: Finding[] = [];
  for (const file of project.files('.html')) {
    let errors: any[] = [];
    try {
      errors = compiler.parseTemplate(project.read(file), file, { preserveWhitespaces: true }).errors || [];
    } catch (e) {
      errors = [{ msg: `parser crashed: ${(e as Error).message}` }];
    }
    for (const e of errors) {
      const line = e.span && e.span.start ? e.span.start.line + 1 : undefined;
      findings.push({ ruleId: TEMPLATE_PARSE_RULE.id, severity: 'error', fixable: false, file, line, message: String(e.msg || e).split('\n')[0] });
    }
  }
  const version = compiler.VERSION && compiler.VERSION.full;
  const note = `Templates parsed with the project's @angular/compiler${version ? ` ${version}` : ''}.`;
  return findings.length ? { result: { rule: TEMPLATE_PARSE_RULE, severity: 'error', findings }, note } : { note };
}
