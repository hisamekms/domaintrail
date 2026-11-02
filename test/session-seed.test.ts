// The session seed (scripts/session-seed.ts) against the built CLI: one small scenario on a free port fills the
// session through its APIs, and leaves no run to the seed's agent.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { seed } from '../scripts/session-seed/seed';
import { scenariosOf } from '../scripts/session-seed/scenarios';
import { withSession } from '../scripts/session-seed/workspace';

const ROOT = path.join(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolve(port));
        });
    });

describe('the session seed', () => {
    test('scenario names: a comma list, repeated, and all', () => {
        expect(scenariosOf(['chat,runs', 'chat'])).toEqual(['chat', 'runs']);
        expect(scenariosOf(['all'])).toHaveLength(8);
        expect(() => scenariosOf(['nope'])).toThrow('Unknown scenario nope');
    });

    test('the session section goes into the JSONC config, with or without a trailing comma', () => {
        expect(withSession('{\n  "a": 1,\n}\n', { port: 1 })).toContain('"a": 1,\n  // added by scripts/session-seed.ts\n  "session": {"port":1},\n}');
        expect(withSession('{ "a": 1 }', { port: 1 })).toContain('"a": 1,\n');
    });

    test('reactions on a free port: messages, one completed run, marks; the agent holds nothing afterwards', async () => {
        const dir = path.join(await mkdtemp(path.join(tmpdir(), 'dt-seed-test-')), 'ws');
        dirs.push(path.dirname(dir));
        const seeded = await seed({
            scenarios: ['reactions'],
            source: path.join(ROOT, 'examples', 'shop'),
            dir,
            reset: false,
            port: await freePort(),
            classifier: true,
            leaveQueued: false,
            dt: { command: 'node', args: [path.join(ROOT, 'dist', 'dt.js')] },
            log: () => {},
            serverLog: () => {},
        });
        try {
            const { state } = seeded;
            expect(state.requests).toHaveLength(3);
            expect(state.runs.map((r) => r.state)).toEqual(['Completed']);
            expect(state.runs[0].state === 'Completed' && state.runs[0].changed).toBe(true);
            expect(state.marks).toHaveLength(35);
            expect(seeded.participants.map((p) => p.me.participant.role)).toEqual(['facilitator', 'participant', 'participant', 'participant', 'participant']);
            expect(seeded.facilitatorLink).toStartWith(`${seeded.url}session/facilitator?code=`);
            // a seed refuses a directory with a session unless --reset, and wipes only its own
            expect(await refusal(dir)).toContain('is running');
        } finally {
            await seeded.stop();
        }
        expect(await refusal(dir)).toContain('already has a session');
    }, 90_000);
    test("undo: a unit undone mechanically, a later one's change kept; another undone by the agent after a conflict", async () => {
        const dir = path.join(await mkdtemp(path.join(tmpdir(), 'dt-seed-test-')), 'ws');
        dirs.push(path.dirname(dir));
        const seeded = await seed({ ...seededOptions(dir), scenarios: ['undo'], port: await freePort(), classifier: true });
        try {
            const { state } = seeded;
            expect(state.runs.map((r) => r.state)).toEqual(['Completed', 'Completed', 'Reverted', 'Completed', 'Completed', 'Completed']);
            const undoes = state.requests.flatMap((r) => (r.undoes ? [[r.undoes, r.body]] : []));
            expect(undoes).toEqual([
                [state.runs[0].id, '「再請求のイベント」の変更を取り消す'],
                [state.runs[3].id, '「支払の督促」の変更を取り消す'],
            ]);
            const file = await readFile(path.join(dir, 'stormings', 'order-to-cash.dtes'), 'utf8');
            expect(file).toContain('readmodel Favorites');
            expect(file).not.toContain('PaymentRetried');
            expect(file).not.toContain('InvoiceReminded');
        } finally {
            await seeded.stop();
        }
    }, 90_000);
});

/** Why a second seed into `dir` is refused. */
const refusal = (dir: string): Promise<string> =>
    seed(seededOptions(dir)).then(
        () => 'seeded',
        (e: unknown) => String(e),
    );

function seededOptions(dir: string): Parameters<typeof seed>[0] {
    return {
        scenarios: [],
        source: path.join(ROOT, 'examples', 'shop'),
        dir,
        reset: false,
        port: 1,
        classifier: false,
        leaveQueued: false,
        dt: { command: 'node', args: [path.join(ROOT, 'dist', 'dt.js')] },
        log: () => {},
        serverLog: () => {},
    };
}
