import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { repositoryTop } from './gitignore.js';

/** The rule of oxlint (`typescript/…`) and typescript-eslint (`@typescript-eslint/…`) that reports narrowing casts. */
export const CAST_RULE = 'no-unsafe-type-assertion';

/** oxlint's config files and ESLint's flat config files. */
export const LINT_CONFIG_FILES = [
    '.oxlintrc.json',
    '.oxlintrc.jsonc',
    ...['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].flatMap((ext) => [`oxlint.config.${ext}`, `eslint.config.${ext}`]),
];

/** What `dt generate ts` prints after `hint: ` when `hasCastLintRule` is false. */
export const LINT_HINT = `no lint rule against casts to domain types found (${CAST_RULE}); see dt guide lint`;

/**
 * Whether a lint config in `root` or a directory above it, up to the top of the enclosing git repository (only `root`
 * without one), mentions `no-unsafe-type-assertion`. A heuristic: the files are searched as text, not evaluated, so a
 * rule that is mentioned but turned off, or set in a config shared from a package, is not told apart.
 */
export async function hasCastLintRule(root: string): Promise<boolean> {
    const top = repositoryTop(root) ?? root;
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
        for (const name of LINT_CONFIG_FILES) {
            const file = path.join(dir, name);
            if (existsSync(file) && (await readFile(file, 'utf8').catch(() => '')).includes(CAST_RULE)) return true;
        }
        if (dir === top || path.dirname(dir) === dir) return false;
    }
}
