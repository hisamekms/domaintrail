// The generation's sections of domaintrail.jsonc, `generate.ts` and `lintHint` (composed with the others and read from a
// file: apps/dt/src/config/config.test.ts; through the CLI: test/config-cli.test.ts).
import { describe, expect, test } from 'bun:test';
import { policyModes, resolveGenerationConfig, staysInside, unknownTsContexts, validateGenerationConfig } from './config.js';

const refusal = (config: Record<string, unknown>): string | undefined => {
    try {
        validateGenerationConfig(config, (msg) => {
            throw new Error(msg);
        });
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

describe('the generation sections', () => {
    test('defaults: generated/domain, optional policies, the lint hint, no contract tests', () => {
        expect(resolveGenerationConfig()).toEqual({
            lintHint: true,
            tsOut: 'generated/domain',
            tsContexts: {},
            tsModules: {},
            tsPolicies: { project: 'optional', contexts: {} },
        });
    });

    test('generate.ts.contexts maps context names to output directories and policies', () => {
        const ts = { out: 'gen', policies: 'required', contexts: { A: { policies: 'optional' }, B: { out: 'b' } }, tests: { runner: 'vitest' } } as const;
        expect(refusal({ lintHint: false, generate: { ts } })).toBeUndefined();
        const c = resolveGenerationConfig({ lintHint: false, generate: { ts } });
        expect(c).toEqual({
            lintHint: false,
            tsOut: 'gen',
            tsContexts: { B: 'b' },
            tsModules: {},
            tsPolicies: { project: 'required', contexts: { A: 'optional' } },
            tsTests: { runner: 'vitest' },
        });
        expect(policyModes(c, ['A', 'B', 'C'])).toEqual({ A: 'optional', B: 'required', C: 'required' });
        expect(policyModes(resolveGenerationConfig(), ['A'])).toEqual({ A: 'optional' });
    });

    test('generate.ts.contexts.<Ctx>.module: the module of the package its out is in', () => {
        const ts = { contexts: { K: { out: 'packages/kernel/src/generated', module: '@acme/kernel' }, L: { out: 'l' } } };
        expect(refusal({ generate: { ts } })).toBeUndefined();
        const c = resolveGenerationConfig({ generate: { ts } });
        expect(c.tsModules).toEqual({ K: '@acme/kernel' });
        expect(c.tsContexts).toEqual({ K: 'packages/kernel/src/generated', L: 'l' });
    });

    test('a context the model does not have', () => {
        const c = resolveGenerationConfig({ generate: { ts: { contexts: { A: { out: 'a' }, X: { policies: 'required' } } } } });
        expect(unknownTsContexts(c, ['A', 'B'])).toBe("'generate.ts.contexts' names 'X', which is not a context of the model (contexts: A, B).");
        expect(unknownTsContexts(c, [])).toBe("'generate.ts.contexts' names 'A', 'X', which are not contexts of the model (contexts: none).");
        expect(unknownTsContexts(c, ['A', 'X'])).toBeUndefined();
    });

    test('an output directory stays inside the root', () => {
        expect(staysInside('src/gen')).toBe(true);
        for (const out of ['../x', '/tmp/x', 'C:\\x', 'a/../../b', 'a\\..\\b']) expect(staysInside(out)).toBe(false);
    });

    test.each([
        [{ lintHint: 'off' }, "'lintHint' must be true or false"],
        [{ generate: [] }, "'generate' must be an object"],
        [{ generate: { rust: {} } }, "unknown generator 'generate.rust' (supported: ts)"],
        [{ generate: { ts: 1 } }, "'generate.ts' must be an object"],
        [{ generate: { ts: { out: '../elsewhere' } } }, "'generate.ts.out' must stay inside the directory of the config file: '../elsewhere'"],
        [{ generate: { ts: { out: '/tmp/x' } } }, "'generate.ts.out' must stay inside the directory of the config file: '/tmp/x'"],
        [{ generate: { ts: { out: 1 } } }, "'generate.ts.out' must be a string"],
        [{ generate: { ts: { outDir: 'x' } } }, "unknown key 'generate.ts.outDir'"],
        [{ generate: { ts: { contexts: [] } } }, "'generate.ts.contexts' must be an object keyed by context name"],
        [{ generate: { ts: { contexts: { C: 'x' } } } }, "'generate.ts.contexts.C' must be an object"],
        [{ generate: { ts: { contexts: { C: {} } } } }, "'generate.ts.contexts.C' needs 'out' or 'policies'"],
        [{ generate: { ts: { contexts: { C: { out: 'x', dir: 'y' } } } } }, "unknown key 'generate.ts.contexts.C.dir'"],
        [
            { generate: { ts: { contexts: { C: { policies: 'required', module: '@acme/c' } } } } },
            "'generate.ts.contexts.C.module' needs 'generate.ts.contexts.C.out': the module is that of the package the context is written into",
        ],
        [
            { generate: { ts: { contexts: { C: { out: 'c', module: '' } } } } },
            "'generate.ts.contexts.C.module' must be a module specifier (a non-empty string)",
        ],
        [{ generate: { ts: { contexts: { C: { out: 'c', module: 1 } } } } }, "'generate.ts.contexts.C.module' must be a module specifier (a non-empty string)"],
        [{ generate: { ts: { policies: 'always' } } }, "'generate.ts.policies' must be one of 'optional', 'required'"],
        [{ generate: { ts: { contexts: { C: { policies: true } } } } }, "'generate.ts.contexts.C.policies' must be one of 'optional', 'required'"],
        [{ generate: { ts: { contexts: { C: { out: '../x' } } } } }, "'generate.ts.contexts.C.out' must stay inside the directory of the config file: '../x'"],
        [{ generate: { ts: { tests: true } } }, "'generate.ts.tests' must be an object"],
        [{ generate: { ts: { tests: { runner: 'mocha' } } } }, "'generate.ts.tests.runner' must be one of 'bun', 'vitest', 'jest', 'node'"],
        [{ generate: { ts: { tests: { out: '../t' } } } }, "'generate.ts.tests.out' must stay inside the directory of the config file: '../t'"],
        [{ generate: { ts: { tests: { dir: 't' } } } }, "unknown key 'generate.ts.tests.dir'"],
    ])('%j is refused', (config, message) => {
        expect(refusal(config)).toBe(message);
    });
});
