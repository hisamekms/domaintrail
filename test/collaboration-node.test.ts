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
const EXTERNAL = Object.keys(pkg.dependencies).flatMap((name) => [name, `${name}/*`]);

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const ENTRY = `
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Collaboration as C, createCollaboration, createUnitOfWork, openSessionBlobs, openSessionDatabase, randomIds, systemClock } from '@domaintrail/collaboration';
import { createModelValidator } from '@domaintrail/dt';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
import { sourceSelection } from '@domaintrail/analysis';

const [root, step] = process.argv.slice(2);
const must = (r) => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
const open = async () => {
    const db = await openSessionDatabase(root);
    return { db, use: createCollaboration({
        uow: createUnitOfWork(db),
        workspace: createWorkspaceSnapshot(root, sourceSelection()),
        blobs: await openSessionBlobs(root),
        validator: createModelValidator(),
        clock: systemClock,
        ids: randomIds,
    }) };
};

if (step === 'run') {
    const { db, use } = await open();
    const facilitator = must(C.makeParticipantId('facilitator'));
    const actor = { kind: 'participant', participant: facilitator, role: 'Facilitator' };
    const { session, revision } = must(await use.startSession({ facilitator, name: must(C.makeDisplayName('Ada')) }));
    const request = must(await use.sendRequest({
        session: session.id,
        actor,
        targets: [{ target: { kind: 'DtElement', element: must(C.makeElementName('Sales.Order')) }, sourceRevision: revision.id }],
        body: must(C.makeText('Add a note.')),
    }));
    const run = must(await use.queueRun({ session: session.id, requests: [request.id], actor }));
    const { lease } = must(await use.claimNextRun({ session: session.id, owner: 'node', leaseMs: 60000 }));
    must(await use.startRun({ run: run.id, token: lease.token }));
    const file = path.join(root, 'sales.dt');
    writeFileSync(file, readFileSync(file, 'utf8').replace('id: OrderId', 'id: OrderId\\n    note: String?'));
    const finished = must(await use.finishRun({ run: run.id, token: lease.token, facts: { exitCode: 0, formatted: 'Ran', checked: 'Ran' } }));
    const restored = must(await use.restoreRevision({ session: session.id, revision: revision.id, actor }));
    db.close();
    console.log(JSON.stringify({ session: session.id, run: finished.run.state, changed: finished.run.changed, restored: restored.restored.contentHash === revision.contentHash }));
} else {
    const { db, use } = await open();
    const state = must(await use.sessionState({ session: step }));
    db.close();
    console.log(JSON.stringify({ runs: state.runs.map((r) => r.state), revisions: state.revisions.map((r) => r.origin.kind) }));
}
`;

/**
 * A server and `dt open link` as two Node processes on one session database: `serve` holds its connection open, as the
 * server does, and asks `issue` (another process: opens the database, issues a sign-in code, closes it) for each code.
 */
const LINKS_ENTRY = `
import { execFileSync } from 'node:child_process';
import { Collaboration as C, createCollaboration, createSessionAccess, createUnitOfWork, openSessionBlobs, openSessionDatabase, randomIds, randomSecrets, systemClock } from '@domaintrail/collaboration';
import { createModelValidator } from '@domaintrail/dt';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
import { sourceSelection } from '@domaintrail/analysis';

const [root, step, session] = process.argv.slice(2);
const must = (r) => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
const db = await openSessionDatabase(root);
const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
if (step === 'issue') {
    const ttlMs = Number(process.argv[5]);
    const code = must(await access.issueOpenCode({ session, ttlMs }));
    db.close();
    console.log(code.code);
} else {
    const use = createCollaboration({
        uow: createUnitOfWork(db),
        workspace: createWorkspaceSnapshot(root, sourceSelection()),
        blobs: await openSessionBlobs(root),
        validator: createModelValidator(),
        clock: systemClock,
        ids: randomIds,
    });
    const facilitator = must(C.makeParticipantId('facilitator'));
    const { session: opened } = must(await use.startSession({ facilitator, name: must(C.makeDisplayName('Ada')), mode: 'Solo' }));
    const issue = (ttlMs) => execFileSync(process.execPath, [process.argv[1], root, 'issue', opened.id, String(ttlMs)]).toString().trim();
    const redeem = (code) => access.redeemOpenCode({ session: opened.id, code });
    const ahead = [issue(60000), issue(60000), issue(60000)];
    const results = { ahead: [], oneByOne: [], again: [], expired: undefined };
    for (const code of ahead) results.ahead.push(await redeem(code));
    for (let i = 0; i < 3; i++) results.oneByOne.push(await redeem(issue(60000)));
    for (const code of ahead) results.again.push(await redeem(code));
    const short = issue(1);
    await new Promise((r) => setTimeout(r, 10));
    results.expired = await redeem(short);
    db.close();
    console.log(JSON.stringify(results));
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
        for (const dir of ['contexts/collaboration/src', 'platform/workspace/src']) {
            for await (const rel of new Glob('**/*.ts').scan({ cwd: path.join(ROOT, dir) })) {
                // the generated contract tests register with bun:test; the unit tests run on Bun and are not bundled
                if (rel.startsWith('generated/tests/') || rel.endsWith('.test.ts') || rel === 'test-helpers.ts') continue;
                const source = await readFile(path.join(ROOT, dir, rel), 'utf8');
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

    test('a sign-in code issued by another process is redeemed by the one holding the database open, each once, again and again', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-node-'));
        dirs.push(dir);
        await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
        await writeFile(path.join(dir, 'links.ts'), LINKS_ENTRY);
        const built = await Bun.build({
            entrypoints: [path.join(dir, 'links.ts')],
            outdir: dir,
            naming: '[name].mjs',
            target: 'node',
            format: 'esm',
            external: EXTERNAL,
        });
        expect(built.success).toBe(true);

        const workspace = await mkdtemp(path.join(tmpdir(), 'domaintrail-node-ws-'));
        dirs.push(workspace);
        await writeFile(path.join(workspace, 'sales.dt'), SALES);
        const served = node([path.join(dir, 'links.mjs'), workspace, 'serve']);
        expect(served.code).toBe(0);
        // codes issued before any is used, then one after another; used and expired ones stay refused
        expect(JSON.parse(served.out)).toEqual({ ahead: [true, true, true], oneByOne: [true, true, true], again: [false, false, false], expired: false });
    }, 30_000);
});
