import { Project, lineOf } from '../project';
import { RawFinding, Rule } from './types';
import { STYLES, TEMPLATES, transformFiles, tsFiles } from './helpers';

// ---------------------------------------------------------------------------
// Design (alignment) regressions after the MDC rewrite of Angular Material (v15+)
// ---------------------------------------------------------------------------

/**
 * Pre-MDC internal class → its MDC counterpart, as the official mdc-migration schematic mapped them.
 * Overrides of the old names silently stop matching, which is where most "everything is misaligned" reports come from.
 */
export const MDC_CLASS_RENAMES: Record<string, string> = {
  // Buttons
  '.mat-button': '.mat-mdc-button', '.mat-raised-button': '.mat-mdc-raised-button', '.mat-flat-button': '.mat-mdc-unelevated-button',
  '.mat-stroked-button': '.mat-mdc-outlined-button', '.mat-icon-button': '.mat-mdc-icon-button', '.mat-fab': '.mat-mdc-fab',
  '.mat-mini-fab': '.mat-mdc-mini-fab', '.mat-button-wrapper': '.mdc-button__label',
  // Form field
  '.mat-form-field': '.mat-mdc-form-field', '.mat-form-field-wrapper': '.mat-mdc-text-field-wrapper', '.mat-form-field-flex': '.mat-mdc-form-field-flex',
  '.mat-form-field-infix': '.mat-mdc-form-field-infix', '.mat-form-field-label': '.mdc-floating-label', '.mat-form-field-underline': '.mdc-line-ripple',
  '.mat-form-field-outline': '.mdc-notched-outline', '.mat-form-field-prefix': '.mat-mdc-form-field-icon-prefix',
  '.mat-form-field-suffix': '.mat-mdc-form-field-icon-suffix', '.mat-form-field-subscript-wrapper': '.mat-mdc-form-field-subscript-wrapper',
  '.mat-input-element': '.mat-mdc-input-element',
  // Select, option, autocomplete
  '.mat-select': '.mat-mdc-select', '.mat-select-trigger': '.mat-mdc-select-trigger', '.mat-select-value': '.mat-mdc-select-value',
  '.mat-select-value-text': '.mat-mdc-select-value-text', '.mat-select-placeholder': '.mat-mdc-select-placeholder',
  '.mat-select-arrow-wrapper': '.mat-mdc-select-arrow-wrapper', '.mat-select-arrow': '.mat-mdc-select-arrow',
  '.mat-select-panel': '.mat-mdc-select-panel', '.mat-select-min-line': '.mat-mdc-select-min-line',
  '.mat-option': '.mat-mdc-option', '.mat-option-text': '.mdc-list-item__primary-text', '.mat-optgroup': '.mat-mdc-optgroup',
  '.mat-autocomplete-panel': '.mat-mdc-autocomplete-panel',
  // Checkbox, radio, slide toggle, slider
  '.mat-checkbox': '.mat-mdc-checkbox', '.mat-checkbox-inner-container': '.mdc-checkbox', '.mat-checkbox-frame': '.mdc-checkbox__background',
  '.mat-checkbox-background': '.mdc-checkbox__background', '.mat-checkbox-checkmark': '.mdc-checkbox__checkmark', '.mat-checkbox-label': '.mdc-label',
  '.mat-radio-button': '.mat-mdc-radio-button', '.mat-radio-container': '.mdc-radio', '.mat-radio-outer-circle': '.mdc-radio__outer-circle',
  '.mat-radio-inner-circle': '.mdc-radio__inner-circle', '.mat-radio-label-content': '.mdc-label',
  '.mat-slide-toggle': '.mat-mdc-slide-toggle', '.mat-slide-toggle-bar': '.mdc-switch__track', '.mat-slide-toggle-thumb': '.mdc-switch__handle',
  '.mat-slider': '.mat-mdc-slider',
  // Tabs
  '.mat-tab-group': '.mat-mdc-tab-group', '.mat-tab-header': '.mat-mdc-tab-header', '.mat-tab-label': '.mat-mdc-tab',
  '.mat-tab-label-active': '.mdc-tab--active', '.mat-tab-label-container': '.mat-mdc-tab-label-container', '.mat-tab-labels': '.mat-mdc-tab-labels',
  '.mat-tab-label-content': '.mdc-tab__content', '.mat-tab-body-wrapper': '.mat-mdc-tab-body-wrapper', '.mat-ink-bar': '.mdc-tab-indicator',
  // Chips, lists, cards
  '.mat-chip-list': '.mat-mdc-chip-set', '.mat-chip': '.mat-mdc-chip', '.mat-standard-chip': '.mat-mdc-standard-chip', '.mat-chip-remove': '.mat-mdc-chip-remove',
  '.mat-list-base': '.mat-mdc-list-base', '.mat-list-item': '.mat-mdc-list-item', '.mat-list-item-content': '.mdc-list-item__content',
  '.mat-card': '.mat-mdc-card', '.mat-card-header-text': '.mat-mdc-card-header-text', '.mat-card-title': '.mat-mdc-card-title',
  '.mat-card-subtitle': '.mat-mdc-card-subtitle', '.mat-card-content': '.mat-mdc-card-content', '.mat-card-actions': '.mat-mdc-card-actions',
  // Dialog, menu, tooltip, snack bar, paginator, progress
  '.mat-dialog-container': '.mat-mdc-dialog-container', '.mat-dialog-content': '.mat-mdc-dialog-content', '.mat-dialog-actions': '.mat-mdc-dialog-actions',
  '.mat-dialog-title': '.mat-mdc-dialog-title', '.mat-menu-panel': '.mat-mdc-menu-panel', '.mat-menu-content': '.mat-mdc-menu-content',
  '.mat-menu-item': '.mat-mdc-menu-item', '.mat-tooltip': '.mat-mdc-tooltip', '.mat-snack-bar-container': '.mat-mdc-snack-bar-container',
  '.mat-paginator': '.mat-mdc-paginator', '.mat-paginator-container': '.mat-mdc-paginator-container',
  '.mat-progress-bar': '.mat-mdc-progress-bar', '.mat-progress-spinner': '.mat-mdc-progress-spinner',
  // Table
  '.mat-table': '.mat-mdc-table', '.mat-header-row': '.mat-mdc-header-row', '.mat-row': '.mat-mdc-row', '.mat-footer-row': '.mat-mdc-footer-row',
  '.mat-header-cell': '.mat-mdc-header-cell', '.mat-cell': '.mat-mdc-cell', '.mat-footer-cell': '.mat-mdc-footer-cell',
};

/** Old internals with no 1:1 MDC class: reported for a hand rewrite. */
export const MDC_NO_EQUIVALENT = new Set([
  '.mat-form-field-label-wrapper', '.mat-form-field-ripple', '.mat-form-field-empty', '.mat-checkbox-layout', '.mat-slide-toggle-content',
  '.mat-radio-label', '.mat-button-focus-overlay', '.mat-button-ripple', '.mat-select-search-hidden',
]);

const MAT_CLASS = /\.mat-[a-z][a-z-]*(?![\w-])/g;

/** [start, end) of each string in an inline `styles:` (component metadata). */
export function inlineStyleRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\bstyles\s*:\s*(\[)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = re.lastIndex;
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      const q = text[i];
      if (q !== '`' && q !== "'" && q !== '"') break;
      let j = i + 1;
      while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
      out.push([i + 1, j]);
      i = j + 1;
      if (!m[1]) break;
    }
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return out;
}

/** Old Material class names the app writes itself (class="mat-card", ngClass, panelClass strings): never renamed. */
export function literalMatClasses(project: Project): Set<string> {
  const out = new Set<string>();
  const strings = /class\s*=\s*"([^"]*)"|'([^'\n]*)'|"([^"\n]*)"/g;
  for (const file of [...project.files(...TEMPLATES), ...tsFiles(project)]) {
    const text = project.read(file);
    let m: RegExpExecArray | null;
    while ((m = strings.exec(text))) {
      for (const token of (m[1] ?? m[2] ?? m[3] ?? '').match(/(?<![\w.-])mat-[a-z][a-z-]*/g) || []) out.add(`.${token}`);
    }
  }
  return out;
}

/** Still on the legacy (pre-MDC) components, whose DOM keeps the old class names. */
export function usesLegacyMaterial(project: Project): boolean {
  return tsFiles(project).some((f) => /@angular\/material\/legacy-/.test(project.read(f)));
}

export interface MdcClassUse {
  offset: number;
  name: string;
  /** The MDC class, when there is one. */
  replacement?: string;
}

/** Old Material class selectors in a stylesheet (or in the inline styles of a component .ts file). */
export function oldMaterialClasses(text: string, file: string): MdcClassUse[] {
  const ranges: Array<[number, number]> = file.endsWith('.ts') ? inlineStyleRanges(text) : [[0, text.length]];
  const out: MdcClassUse[] = [];
  for (const [start, end] of ranges) {
    const re = new RegExp(MAT_CLASS.source, 'g');
    const part = text.slice(start, end);
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      const name = m[0];
      if (MDC_CLASS_RENAMES[name]) out.push({ offset: start + m.index, name, replacement: MDC_CLASS_RENAMES[name] });
      else if (MDC_NO_EQUIVALENT.has(name)) out.push({ offset: start + m.index, name });
    }
  }
  return out;
}

/** Rewrites the renamable old classes, except those in `keep`. */
export function renameMdcClasses(text: string, file: string, keep: Set<string> = new Set()): string {
  for (const u of oldMaterialClasses(text, file).reverse()) {
    if (u.replacement && !keep.has(u.name)) text = text.slice(0, u.offset) + u.replacement + text.slice(u.offset + u.name.length);
  }
  return text;
}

/** Stylesheets and component .ts files with inline styles. */
export function styleSources(project: Project): string[] {
  return [...project.files(...STYLES), ...tsFiles(project).filter((f) => /\bstyles\s*:/.test(project.read(f)))];
}

// ---------------------------------------------------------------------------

function templateSources(project: Project): string[] {
  return [...project.files(...TEMPLATES), ...tsFiles(project).filter((f) => /\btemplate\s*:/.test(project.read(f)))];
}

/** `appearance="legacy|standard"` and `floatLabel="never"` (template attributes, bound literals, default options). */
const REMOVED_FORM_FIELD_ATTR = /\s+(?:\[(appearance|floatLabel)\]\s*=\s*"\s*'(legacy|standard|never)'\s*"|(appearance|floatLabel)\s*=\s*"(legacy|standard|never)")/g;
const REMOVED_FORM_FIELD_OPTION = /\b(appearance|floatLabel)(\s*:\s*)(['"])(legacy|standard|never)\3/g;

export function removedFormFieldOptions(text: string, file: string): Array<{ offset: number; end: number; name: string; value: string; replacement: string }> {
  const out: Array<{ offset: number; end: number; name: string; value: string; replacement: string }> = [];
  let m: RegExpExecArray | null;
  const attr = new RegExp(REMOVED_FORM_FIELD_ATTR.source, 'g');
  while ((m = attr.exec(text))) {
    const name = m[1] || m[3];
    const value = m[2] || m[4];
    if ((name === 'floatLabel') !== (value === 'never')) continue;
    out.push({ offset: m.index, end: m.index + m[0].length, name, value, replacement: '' });
  }
  if (file.endsWith('.ts')) {
    const opt = new RegExp(REMOVED_FORM_FIELD_OPTION.source, 'g');
    while ((m = opt.exec(text))) {
      if ((m[1] === 'floatLabel') !== (m[4] === 'never')) continue;
      // Already covered as a template attribute inside an inline template.
      if (out.some((o) => o.offset <= m!.index && m!.index < o.end)) continue;
      out.push({ offset: m.index, end: m.index + m[0].length, name: m[1], value: m[4], replacement: `${m[1]}${m[2]}${m[3]}${m[4] === 'never' ? 'auto' : 'fill'}${m[3]}` });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

const formFieldAppearance: Rule = {
  id: 'material/form-field-appearance',
  hop: 'v15-17',
  title: 'appearance="legacy"/"standard" and floatLabel="never" were removed with the legacy form field',
  since: 15,
  deprecatedIn: 15,
  fixRequires: 15,
  hint: 'The MDC form field only knows appearance "fill" (default) and "outline", and floatLabel "auto"/"always". The removed values silently fall back to fill — grey background, taller field, label inside — so some fields look different from their neighbours (and strictTemplates reports TS2322). The fix removes the attributes so one app-wide default applies, and maps removed values in default options to fill/auto. Pick the look once: providers: [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: \'outline\', subscriptSizing: \'dynamic\' } }]. To keep fill without the grey box (v18+): @include mat.form-field-overrides((filled-container-color: transparent)).',
  docs: 'https://material.angular.dev/components/form-field/api',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of [...new Set([...templateSources(project), ...tsFiles(project).filter((f) => /MAT_FORM_FIELD_DEFAULT_OPTIONS/.test(project.read(f)))])]) {
      const text = project.read(file);
      for (const r of removedFormFieldOptions(text, file)) {
        out.push({ file, line: lineOf(text, r.offset + 1), message: `${r.name} "${r.value}" no longer exists → ${r.replacement ? r.replacement.replace(/\s+/g, ' ') : 'removed (app default applies)'}` });
      }
    }
    return out;
  },
  fix({ project }) {
    transformFiles(project, [...templateSources(project), ...tsFiles(project)], (text, file) => {
      for (const r of removedFormFieldOptions(text, file).reverse()) text = text.slice(0, r.offset) + r.replacement + text.slice(r.end);
      return text;
    });
  },
};

const SELECTION_TAG = /<(mat-select|mat-autocomplete)\b([^>]*)>/g;

/** Single-selection <mat-select>/<mat-autocomplete> tags that show the v16+ check mark on the selected option. */
export function singleSelectionIndicators(text: string): Array<{ offset: number; tag: string }> {
  const out: Array<{ offset: number; tag: string }> = [];
  const re = new RegExp(SELECTION_TAG.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (/hideSingleSelectionIndicator|\[?multiple\]?(?![\w-])/.test(m[2])) continue;
    out.push({ offset: m.index + 1 + m[1].length, tag: m[1] });
  }
  return out;
}

const selectSelectionIndicator: Rule = {
  id: 'material/select-selection-indicator',
  hop: 'v16+',
  title: 'Single-selection mat-select / mat-autocomplete show a check mark on the selected option (v16+)',
  since: 16,
  level: 'info',
  fixRequires: 16,
  hint: 'Since v16 the selected option of a single-selection mat-select or mat-autocomplete gets a ✓ at the end of the row, which also narrows the option text. The fix adds hideSingleSelectionIndicator to each one (restoring the pre-upgrade look); app-wide instead: { provide: MAT_SELECT_CONFIG, useValue: { hideSingleSelectionIndicator: true } } and MAT_AUTOCOMPLETE_DEFAULT_OPTIONS. Applied by `finalize`, or `current --fix --only material/select-selection-indicator`.',
  check({ project }) {
    const configured = tsFiles(project).some((f) => /hideSingleSelectionIndicator\s*:\s*true/.test(project.read(f)));
    const out: RawFinding[] = [];
    for (const file of templateSources(project)) {
      const text = project.read(file);
      const found = singleSelectionIndicators(text).filter((s) => !(configured && s.tag === 'mat-select'));
      if (found.length) out.push({ file, line: lineOf(text, found[0].offset), message: `${found.length} single-selection ${[...new Set(found.map((f) => f.tag))].join('/')} show a ✓ on the selected option → hideSingleSelectionIndicator` });
    }
    return out;
  },
  fix({ project }) {
    const configured = tsFiles(project).some((f) => /hideSingleSelectionIndicator\s*:\s*true/.test(project.read(f)));
    transformFiles(project, templateSources(project), (text) => {
      for (const s of singleSelectionIndicators(text).reverse()) {
        if (!(configured && s.tag === 'mat-select')) text = `${text.slice(0, s.offset)} hideSingleSelectionIndicator${text.slice(s.offset)}`;
      }
      return text;
    });
  },
};

const INPUT_IN_OPTION = /<mat-option\b[^>]*>(?:(?!<\/mat-option>)[\s\S])*?<input\b/g;

const inputInOption: Rule = {
  id: 'material/input-in-option',
  hop: 'v15-17',
  title: 'A search <input> inside <mat-option> (MDC options treat it as a selectable row)',
  since: 15,
  deprecatedIn: 15,
  hint: 'An MDC option is a full list item: the row with the input gets the hover/focus background, the ripple and the ✓ when its value matches, and Space/Enter while typing select the option or close the panel. Use ngx-mat-select-search (<mat-option><ngx-mat-select-search [formControl]="filterCtrl"></ngx-mat-select-search></mat-option>), or put the input above the options outside <mat-option> with (keydown)="$event.stopPropagation()".',
  check({ project }) {
    const out: RawFinding[] = [];
    for (const file of templateSources(project)) {
      const text = project.read(file);
      const re = new RegExp(INPUT_IN_OPTION.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push({ file, line: lineOf(text, m.index + m[0].length - 6), message: '<input> inside <mat-option> → ngx-mat-select-search, or an input outside the options' });
      }
    }
    return out;
  },
};

export const mdcDesignRules: Rule[] = [formFieldAppearance, selectSelectionIndicator, inputInOption];
