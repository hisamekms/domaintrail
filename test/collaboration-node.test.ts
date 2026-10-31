// The collaboration store runs in the CLI, on Node (>= 22.13, node:sqlite unflagged), while the tests run on Bun. This
// bundles a session's whole stack for Node the way scripts/build.ts bundles the CLI (the root's dependencies kept
// external) and runs it with `node`: a file database, blobs, the workspace snapshot and the analyzer, through the use
// cases from a session's start to a restore, and a second process that reads what the first stored.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Glob } from 'bun';
import pkg from '../package.json' with { type: 'json' };

const ROOT = path.join(import.meta.dir, '..');
const SRC = path.join(ROOT, 'packages');
const EXTERNAL = Object.keys(pkg.dependencies).flatMap((name) => [name, `${name}/*`]);

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const ENTRY = `
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Collaboration as C } from '${SRC}/collaboration/src/generated/index.ts';
import { createCollaboration } from '${SRC}/collaboration/src/application/use-cases.ts';
import { openSessionBlobs } from '${SRC}/collaboration/src/infrastructure/blobs.ts';
import { createUnitOfWork, openSessionDatabase } from '${SRC}/collaboration/src/infrastructure/sqlite.ts';
import { randomIds, systemClock } from '${SRC}/collaboration/src/infrastructure/system.ts';
import { createModelValidator } from '${SRC}/collaboration/src/infrastructure/validator.ts';
import { createWorkspaceSnapshot } from '${SRC}/workspace/src/infrastructure/snapshot.ts';

const [root, step] = process.argv.slice(2);
const must = (r) => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
const open = async () => {
    const db = await openSessionDatabase(root);
    return { db, use: createCollaboration({
        uow: createUnitOfWork(db),
        workspace: createWorkspaceSnapshot(root),
        blobs: await openSessionBlobs(root),
        validator: createModelValidator(),
        clock: systemClock,
        ids: randomIds,
    }) };
};

if (step === 'run') {
    const { db, use } = await open();
    const facilitator = must(C.makeParticipantId('facilitator'));
    const { session, revision } = must(await use.startSession({ facilitator, name: must(C.makeDisplayName('Ada')) }));
    const request = must(await use.sendRequest({
        session: session.id,
        author: facilitator,
        target: { target: { kind: 'DtElement', element: must(C.makeElementName('Sales.Order')) }, sourceRevision: revision.id },
        body: must(C.makeText('Add a note.')),
    }));
    const run = must(await use.queueRun({ session: session.id, requests: [request.id], queuedBy: facilitator }));
    const { lease } = must(await use.claimNextRun({ session: session.id, owner: 'node', leaseMs: 60000 }));
    must(await use.startRun({ run: run.id, token: lease.token }));
    const file = path.join(root, 'sales.dt');
    writeFileSync(file, readFileSync(file, 'utf8').replace('id: OrderId', 'id: OrderId\\n    note: String?'));
    const finished = must(await use.finishRun({ run: run.id, token: lease.token, facts: { exitCode: 0, formatted: true, checked: true } }));
    const restored = must(await use.restoreRevision({ session: session.id, revision: revision.id, by: facilitator }));
    db.close();
    console.log(JSON.stringify({ session: session.id, run: finished.run.state, changed: finished.run.changed, restored: restored.restored.contentHash === revision.contentHash }));
} else {
    const { db, use } = await open();
    const state = must(await use.sessionState({ session: step }));
    db.close();
    console.log(JSON.stringify({ runs: state.runs.map((r) => r.state), revisions: state.revisions.map((r) => r.origin.kind) }));
}
`;

const SALES = `context Sales {
  id OrderId: UUID

  aggregate Order {
    id: OrderId
  }
}
`;

function node(args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(['node', ...args]);
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe('collaboration on Node', () => {
    test('the sources the CLI bundles use no Bun API', async () => {
        const offending: string[] = [];
        for (const dir of ['collaboration/src', 'workspace/src']) {
            for await (const rel of new Glob('**/*.ts').scan({ cwd: path.join(SRC, dir) })) {
                if (rel.startsWith('generated/tests/')) continue; // the generated contract tests register with bun:test
                const source = await readFile(path.join(SRC, dir, rel), 'utf8');
                if (/\bBun\.|from ['"]bun(:[\w-]+)?['"]/.test(source)) offending.push(`${dir}/${rel}`);
            }
        }
        expect(offending).toEqual([]);
    });

    test('a session runs from start to restore with node:sqlite under node, and a second process reads it back', async () => {
        expect(node(['--version']).code).toBe(0);
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-node-'));
        dirs.push(dir);
        await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
        await writeFile(path.join(dir, 'entry.ts'), ENTRY);
        const built = await Bun.build({
            entrypoints: [path.join(dir, 'entry.ts')],
            outdir: dir,
            naming: '[name].mjs',
            target: 'node',
            format: 'esm',
            external: EXTERNAL,
        });
        expect(built.logs.map(String)).toEqual([]);
        expect(built.success).toBe(true);

        const workspace = await mkdtemp(path.join(tmpdir(), 'domaintrail-node-ws-'));
        dirs.push(workspace);
        await writeFile(path.join(workspace, 'sales.dt'), SALES);
        const first = node([path.join(dir, 'entry.mjs'), workspace, 'run']);
        expect(first.code).toBe(0);
        const result = JSON.parse(first.out) as { session: string; run: string; changed: boolean; restored: boolean };
        expect(result).toEqual({ session: expect.any(String), run: 'Completed', changed: true, restored: true });
        expect(await readFile(path.join(workspace, 'sales.dt'), 'utf8')).toBe(SALES);

        const second = node([path.join(dir, 'entry.mjs'), workspace, result.session]);
        expect(second.code).toBe(0);
        expect(JSON.parse(second.out)).toEqual({ runs: ['Completed'], revisions: ['SessionStart', 'RunBase', 'RunResult', 'PreRestore', 'Restored'] });
    }, 30_000);
});
