// Helpers of the workspace's unit tests (counted as test code by the bundle and the layer rules).
import * as path from 'node:path';
import type { SourceSelection } from './ports.js';

const IGNORED = new Set(['node_modules', '.git', '.domaintrail']);

/**
 * A selection as the app gives it, without the configuration's globs (the analysis's `sourceSelection`): the files
 * `matches` takes, by `/`-separated path, never under `node_modules`, `.git` or `.domaintrail`. By default every `.dt`
 * and `.dtes` file.
 */
export function selection(matches: (rel: string) => boolean = (rel) => /\.dt(es)?$/.test(rel), respectGitignore = true): SourceSelection {
    return {
        matches: (rel) => {
            const p = rel.split(path.sep).join('/');
            return !p.split('/').some((seg) => IGNORED.has(seg)) && matches(p);
        },
        ignoredDirs: IGNORED,
        respectGitignore,
    };
}
