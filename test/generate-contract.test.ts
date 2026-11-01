/**
 * Baseline of ADR 0027 (plan T0): every file `dt generate ts` writes for examples/shop, as its config asks (the output
 * directory, Billing's required policies, the contract tests for bun), in full, so that a change shows as a diff. The
 * generator's moves (T5, T8) keep them byte for byte. `test/live-contract.test.ts` pins their hashes with `--out`;
 * `test/collaboration-contracts.test.ts` pins Collaboration's committed output. A deliberate change updates the
 * snapshots with `bun test -u` and says why in its commit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { Glob } from 'bun';
import { cliDeps } from '@domaintrail/composition';
import { runCli } from '@domaintrail/dt';
import { tempCopyOfExamples } from './helpers.js';

let dir: string;
let run: { code: number; lines: string[] };
const written: Record<string, string> = {};

beforeAll(async () => {
    dir = await tempCopyOfExamples();
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(`out: ${l}`), err: (l: string) => lines.push(`err: ${l}`) };
    const code = await runCli(['-r', dir, 'generate', 'ts'], io, cliDeps());
    // the output directories are printed relative to the working directory
    const relative = path.relative(process.cwd(), dir);
    run = { code, lines: lines.map((l) => l.replaceAll(relative, '<root>').replaceAll(dir, '<root>')) };
    const files = await Array.fromAsync(new Glob('generated/**/*').scan({ cwd: dir }));
    for (const rel of files.sort()) written[rel] = await readFile(path.join(dir, rel), 'utf8');
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('dt generate ts of examples/shop', () => {
    test('what it prints and the files it writes', () => {
        expect({ ...run, files: Object.keys(written) }).toMatchSnapshot();
    });

    test('the contents of each file', () => {
        expect(Object.keys(written).length).toBeGreaterThan(0);
        for (const [file, text] of Object.entries(written)) expect(text).toMatchSnapshot(file);
    });
});
