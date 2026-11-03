import { Rule } from './types';
import { envRules } from './env';
import { legacyRules } from './v6-v10';
import { midRules } from './v11-v14';
import { modernRules } from './v15-v22';
import { mdcDesignRules } from './mdc-design';

/** Add new rules here as you hit new problems during the upgrade. */
export const RULES: Rule[] = [...envRules, ...legacyRules, ...midRules, ...modernRules, ...mdcDesignRules];

export * from './types';
