// The analysis's section of domaintrail.jsonc, `sources` and `respectGitignore` (composed with the others and read
// from a file: apps/dt/src/config/config.test.ts).
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { DEFAULT_SOURCES, resolveSourcesConfig, sourceMatcher, sourceSelection, validateSourcesConfig } from './sources.js';

const refusal = (config: Record<string, unknown>): string | undefined => {
    try {
        validateSourcesConfig(config, (msg) => {
            throw new Error(msg);
        });
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

describe('the sources section', () => {
    test('defaults: every .dt and .dtes file, .gitignore respected', () => {
        expect(resolveSourcesConfig()).toEqual({ sources: ['**/*.dt', '**/*.dtes'], respectGitignore: true });
        expect(resolveSourcesConfig({ sources: ['a/*.dt'], respectGitignore: false })).toEqual({ sources: ['a/*.dt'], respectGitignore: false });
        expect(refusal({ sources: ['a/**/*.dt', '!a/drafts/**'], respectGitignore: false })).toBeUndefined();
    });

    test.each([
        [{ sources: 'a' }, "'sources' must be an array of glob strings"],
        [{ sources: [1] }, "'sources' must be an array of glob strings"],
        [{ sources: ['!x/**'] }, "'sources' needs at least one include pattern"],
        [{ sources: ['../model/*.dt'] }, "'sources' must stay inside the directory of the config file: '../model/*.dt'"],
        [{ sources: ['*.dt', '!/abs/**'] }, "'sources' must stay inside the directory of the config file: '!/abs/**'"],
        [{ respectGitignore: 'no' }, "'respectGitignore' must be true or false"],
    ])('%j is refused', (config, message) => {
        expect(refusal(config)).toBe(message);
    });

    test('the matcher: includes, `!` excludes, nothing under the directories never scanned', () => {
        const matches = sourceMatcher(['domain/**/*.dt', '!domain/drafts/**']);
        expect(matches('domain/sales/order.dt')).toBe(true);
        expect(matches(['domain', 'sales', 'order.dt'].join(path.sep))).toBe(true);
        expect(matches('domain/drafts/wip.dt')).toBe(false);
        expect(matches('other/x.dt')).toBe(false);
        expect(sourceMatcher(DEFAULT_SOURCES)('node_modules/p/a.dt')).toBe(false);
        expect(sourceMatcher(DEFAULT_SOURCES)('.hidden/a.dtes')).toBe(true);
    });

    test("the workspace's selection: the matcher, the directories never walked, .gitignore", () => {
        const selection = sourceSelection(['*.dt'], false);
        expect(selection.matches('a.dt')).toBe(true);
        expect(selection.matches('a.dtes')).toBe(false);
        expect([...selection.ignoredDirs]).toEqual(['node_modules', '.git', '.domaintrail']);
        expect(selection.respectGitignore).toBe(false);
        expect(sourceSelection().matches('a/b.dtes')).toBe(true);
    });
});
