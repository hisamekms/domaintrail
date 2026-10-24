// Regenerates the tree-sitter grammar (tree-sitter-domaintrail/src), runs its corpus tests and builds
// tree-sitter-domaintrail.wasm, then writes build-stamp.json: the hashes of grammar.js, the generated parser and the
// wasm. test/tree-sitter.test.ts parses with the committed wasm and fails when the stamp is stale, so CI needs neither
// the tree-sitter CLI nor the wasi-sdk it downloads (about 100 MB, once) to build the wasm.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const GRAMMAR_DIR = path.join(import.meta.dir, '..', 'tree-sitter-domaintrail');
export const STAMP = path.join(GRAMMAR_DIR, 'build-stamp.json');
/** The files whose hashes the stamp records, relative to the grammar directory. */
export const STAMPED = ['grammar.js', 'src/parser.c', 'tree-sitter-domaintrail.wasm'];

export async function hashes(): Promise<Record<string, string>> {
    const entries = await Promise.all(
        STAMPED.map(async (f) => [f, createHash('sha256').update(await readFile(path.join(GRAMMAR_DIR, f))).digest('hex')] as const),
    );
    return Object.fromEntries(entries);
}

async function run(...args: string[]): Promise<void> {
    console.log(`$ ${args.join(' ')}`);
    const proc = Bun.spawn(args, { cwd: GRAMMAR_DIR, stdout: 'inherit', stderr: 'inherit' });
    if ((await proc.exited) !== 0) process.exit(1);
}

if (import.meta.main) {
    await run('npm', 'install', '--no-audit', '--no-fund');
    await run('npx', 'tree-sitter', 'generate', '--abi', '14');
    await run('npx', 'tree-sitter', 'test');
    await run('npx', 'tree-sitter', 'build', '--wasm');
    await writeFile(STAMP, `${JSON.stringify(await hashes(), null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), STAMP)}`);
}
