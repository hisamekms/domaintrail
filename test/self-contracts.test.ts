// DomainTrail's own model (ADR 0027, Modeling is described in its own `.dt`; ADR 0028, decision 9): the root
// domaintrail.jsonc covers the kernel (shared/kernel/model), Modeling (contexts/modeling/model) and Collaboration
// (contexts/collaboration/model), and writes each into its package's src/generated (committed), with its contract
// tests in src/generated/tests. The model checks clean and is formatted, and generating it again gives exactly the
// committed files, but for the version of domaintrail their contract tests state: after changing the model or the
// generator, run `bun run dt generate ts` at the root
// (CONTRIBUTING.md, Bootstrap).
import { afterAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Glob } from 'bun';
import { cliDeps, runCli } from '@domaintrail/dt';
import { withoutVersion } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
/** The packages written to, with their model and the directory of their generated code. */
const PACKAGES = ['shared/kernel', 'contexts/modeling', 'contexts/collaboration'];
const GENERATED = 'src/generated';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function dt(args: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const code = await runCli(args, { out: (l) => lines.push(l), err: (l) => lines.push(l) }, cliDeps());
    return { code, out: lines.join('\n') };
}

/** The files below a directory, relative to it, with their contents. */
async function files(dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for await (const rel of new Glob('**/*').scan({ cwd: dir })) result[rel] = await readFile(path.join(dir, rel), 'utf8');
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

describe("DomainTrail's own model", () => {
    test('checks without errors or warnings, every context of it', async () => {
        const { code, out } = await dt(['-r', ROOT, 'check']);
        expect(out).toContain(`0 error(s), 0 warning(s)`);
        expect(code).toBe(0);
    });

    test('is formatted', async () => {
        const { code, out } = await dt(['-r', ROOT, 'fmt', '--check']);
        expect({ code, out }).toEqual({ code: 0, out: expect.any(String) });
    });

    test("generating again gives each package's committed src/generated", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-self-'));
        dirs.push(dir);
        await cp(path.join(ROOT, 'domaintrail.jsonc'), path.join(dir, 'domaintrail.jsonc'));
        for (const p of PACKAGES) await cp(path.join(ROOT, p, 'model'), path.join(dir, p, 'model'), { recursive: true });
        const { code, out } = await dt(['-r', dir, 'generate', 'ts']);
        expect({ code, out }).toEqual({ code: 0, out: expect.any(String) });

        for (const p of PACKAGES) {
            const committed = await files(path.join(ROOT, p, GENERATED));
            const regenerated = await files(path.join(dir, p, GENERATED));
            expect(Object.keys(committed).length).toBeGreaterThan(0);
            expect({ p, files: Object.keys(regenerated) }).toEqual({ p, files: Object.keys(committed) });
            // but for the version of domaintrail the contract tests state, which a patch release leaves (docs/releasing.md)
            for (const [file, text] of Object.entries(regenerated))
                expect({ p, file, text: withoutVersion(text) }).toEqual({ p, file, text: withoutVersion(committed[file]) });
        }
    });
});
