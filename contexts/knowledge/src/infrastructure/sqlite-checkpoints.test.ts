// The checkpoint's held operations that quote a redacted message are forgotten (ADR 0031, section 7); the others stay.
import { describe, expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { EMPTY_CHECKPOINT } from '../application/extraction.js';
import { content, itemId, sessionRef, source, version } from '../test-helpers.js';
import { createSqliteCheckpoints, forgetHeldQuotes } from './sqlite-checkpoints.js';

describe('forgetHeldQuotes', () => {
    test('drops the held operations citing a message, keeps the rest', async () => {
        const db = new DatabaseSync(':memory:');
        const checkpoints = createSqliteCheckpoints(db);
        const session = sessionRef('s1');
        const heldAt = new Date('2026-11-05T09:00:00Z');
        await checkpoints.save(session, {
            ...EMPTY_CHECKPOINT,
            number: 2,
            held: [
                {
                    operation: {
                        kind: 'Conflict',
                        id: itemId('kn_00000002'),
                        content: content('x'),
                        sources: [source('s1', 'm1', '携帯は090')],
                        item: itemId('kn_00000001'),
                        base: version(1),
                    },
                    heldIn: 1,
                    heldAt,
                },
                {
                    operation: { kind: 'Update', item: itemId('kn_00000001'), base: version(1), revised: content('y'), sources: [source('s1', 'm2')] },
                    heldIn: 2,
                    heldAt,
                },
            ],
        });
        expect(forgetHeldQuotes(db, [{ session, message: source('s1', 'm1').message }])).toBe(1);
        const after = await checkpoints.load(session);
        expect(after.held.map((h) => h.operation.kind)).toEqual(['Update']);
        expect(JSON.stringify(db.prepare('SELECT held FROM knowledge_extractions').all())).not.toContain('携帯は090');
    });
});
