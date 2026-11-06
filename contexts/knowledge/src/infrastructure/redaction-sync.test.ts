// Following the redaction log (application/redaction-sync.ts) over the `files` store: the sweep's entries redacted once, the cursor
// kept (in the session database's table) so that the next run reads on; a failure leaves the cursor where it was.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Knowledge } from '../generated/index.js';
import { createFilesKnowledgeStore, type FilesKnowledgeStore } from './files.js';
import { createSqliteRedactionCursors } from './sqlite-redaction-cursors.js';
import { content, extraction, itemId, source, userName } from '../test-helpers.js';
import { createRedactionSync, type RedactionCursors } from '../application/redaction-sync.js';

const project = 'shop' as Knowledge.ProjectName;
let root: string;
let clock: Date;
let store: FilesKnowledgeStore;
let cursors: RedactionCursors;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-redaction-'));
    clock = new Date('2026-11-05T09:00:00Z');
    store = createFilesKnowledgeStore({
        dir: path.join(root, 'knowledge'),
        project,
        stateDir: path.join(root, 'state'),
        undoWindowMs: 60_000,
        now: () => clock,
    });
    cursors = createSqliteRedactionCursors(new DatabaseSync(':memory:'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function addAndDelete(n: number): Promise<void> {
    const id = itemId(`kn_0000000${n}`);
    await store.applyExtraction(project, {
        by: extraction('s1', n),
        operations: [{ kind: 'Add', id, content: content(`finding ${n}`), sources: [source('s1', `m${n}`), source('s1', `m${n}b`)] }],
    });
    await store.delete(project, id, userName('alice@example.com'));
}

describe('the redaction sync', () => {
    test('redacts the messages of the items the sweep removed, once, and keeps where it read up to', async () => {
        const redacted: string[][] = [];
        const sync = createRedactionSync({
            store,
            project,
            cursors,
            sweep: () => store.sweep(),
            redact: async (messages) => void redacted.push(messages.map((m) => `${m.session}/${m.message}`)),
            log: () => undefined,
        });
        await addAndDelete(1);
        // within the undo window: nothing yet
        expect(await sync.run()).toBe(0);
        clock = new Date(clock.getTime() + 61_000);
        expect(await sync.run()).toBe(1);
        expect(redacted).toEqual([['s1/m1', 's1/m1b']]);
        expect(await cursors.get(project)).toBeString();
        // read on from the cursor: nothing again, then only the next deletion
        expect(await sync.run()).toBe(0);
        await addAndDelete(2);
        clock = new Date(clock.getTime() + 61_000);
        expect(await sync.run()).toBe(1);
        expect(redacted).toEqual([
            ['s1/m1', 's1/m1b'],
            ['s1/m2', 's1/m2b'],
        ]);
    });

    test('a failed redaction leaves the cursor, and the next run reads the same entries again', async () => {
        const lines: string[] = [];
        let fail = true;
        const redacted: number[] = [];
        const sync = createRedactionSync({
            store,
            project,
            cursors,
            sweep: () => store.sweep(),
            redact: async (messages) => {
                if (fail) throw new Error('database locked');
                redacted.push(messages.length);
            },
            log: (l) => lines.push(l),
        });
        await addAndDelete(1);
        clock = new Date(clock.getTime() + 61_000);
        expect(await sync.run()).toBe(0);
        expect(lines[0]).toContain('database locked');
        expect(await cursors.get(project)).toBeUndefined();
        fail = false;
        expect(await sync.run()).toBe(1);
        expect(redacted).toEqual([2]);
    });
});
