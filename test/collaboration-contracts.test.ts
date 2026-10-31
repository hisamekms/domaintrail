// The collaboration contracts (ADR 0026): packages/collaboration/model is a .dt model whose generated TypeScript is
// committed in packages/collaboration/src/generated. The model checks clean and is formatted, and generating it again
// gives exactly the committed files: after changing the model, run `bun run dt -r packages/collaboration generate ts`.
import { afterAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Glob } from 'bun';
import { cliDeps } from '@domaintrail/composition/cli';
import { runCli } from '@domaintrail/presentation/cli/main';

const PACKAGE = path.join(import.meta.dir, '..', 'packages', 'collaboration');
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

describe('collaboration contracts', () => {
    test('the model checks without errors or warnings', async () => {
        const { code, out } = await dt(['-r', PACKAGE, 'check']);
        expect(out).toContain('0 error(s), 0 warning(s)');
        expect(code).toBe(0);
    });

    test('the model is formatted', async () => {
        const { code, out } = await dt(['-r', PACKAGE, 'fmt', '--check']);
        expect({ code, out }).toEqual({ code: 0, out: expect.any(String) });
    });

    test('generating again gives the committed src/generated', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-collaboration-'));
        dirs.push(dir);
        await cp(path.join(PACKAGE, 'domaintrail.jsonc'), path.join(dir, 'domaintrail.jsonc'));
        await cp(path.join(PACKAGE, 'model'), path.join(dir, 'model'), { recursive: true });
        const { code, out } = await dt(['-r', dir, 'generate', 'ts']);
        expect({ code, out }).toEqual({ code: 0, out: expect.any(String) });

        const committed = await files(path.join(PACKAGE, GENERATED));
        const regenerated = await files(path.join(dir, GENERATED));
        expect(Object.keys(committed).length).toBeGreaterThan(0);
        expect(Object.keys(regenerated)).toEqual(Object.keys(committed));
        for (const [file, text] of Object.entries(regenerated)) expect({ file, text }).toEqual({ file, text: committed[file] });
    });
});
