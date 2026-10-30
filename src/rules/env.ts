import * as semver from 'semver';
import { requirementsFor, recommendedFromRange } from '../versions';
import { Rule, RawFinding } from './types';

/** Checks that run on every hop: Node, TypeScript, RxJS and zone.js ranges. */
export const envRules: Rule[] = [
  {
    id: 'env/node-version',
    hop: 'every hop',
    title: 'Node.js version must match the Angular CLI requirement',
    since: 6,
    removedIn: 6,
    hint: 'Install a matching Node with nvm (nvm install <version> && nvm use <version>). Keep one Node per hop if needed.',
    docs: 'https://angular.dev/reference/versions',
    check({ version }) {
      const req = requirementsFor(version);
      const node = process.versions.node;
      if (!req || semver.satisfies(node, req.node)) return [];
      return [{
        message: `Node ${node} is outside the range Angular ${version} supports (${req.node}). Suggested: Node ${recommendedFromRange(req.node)}.`,
      }];
    },
  },
  {
    id: 'env/typescript-version',
    hop: 'every hop',
    title: 'TypeScript version must match the Angular compiler',
    since: 6,
    deprecatedIn: 6,
    hint: '`ng update @angular/core@<N>` usually bumps TypeScript. If it does not: npm i -D typescript@"<range>".',
    check({ project, version, mode }) {
      return rangeCheck(project.versionOf('typescript'), requirementsFor(version)?.typescript, 'typescript', version, mode);
    },
  },
  {
    id: 'env/rxjs-version',
    hop: 'every hop',
    title: 'RxJS version must be supported',
    since: 6,
    deprecatedIn: 6,
    hint: 'npm i rxjs@"<range>". Moving to RxJS 7 needs deep imports and rxjs-compat cleaned up first.',
    check({ project, version, mode }) {
      return rangeCheck(project.versionOf('rxjs'), requirementsFor(version)?.rxjs, 'rxjs', version, mode);
    },
  },
  {
    id: 'env/zone-version',
    hop: 'every hop',
    title: 'zone.js version must be supported',
    since: 6,
    deprecatedIn: 6,
    hint: '`ng update` normally bumps zone.js. Otherwise npm i zone.js@"<range>".',
    check({ project, version, mode }) {
      return rangeCheck(project.versionOf('zone.js'), requirementsFor(version)?.zone, 'zone.js', version, mode);
    },
  },
];

function rangeCheck(installed: string | undefined, range: string | undefined, name: string, version: number, mode: string): RawFinding[] {
  if (!installed || !range || semver.satisfies(installed, range)) return [];
  const when = mode === 'target' ? `Angular ${version} needs` : `Angular ${version} expects`;
  return [{ file: 'package.json', message: `${name} ${installed} — ${when} ${range}.` }];
}
