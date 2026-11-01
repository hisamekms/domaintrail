// The rows marked as added, changed and removed against the baseline's graph (the model diff: modeling's model/diff.test.ts).
import { describe, expect, test } from 'bun:test';
import { buildStructureGraph } from './build.js';
import { markLineChanges } from './line-changes.js';
import { check } from '../../test-helpers.js';

describe('markLineChanges', () => {
    test('leaves graphs without a baseline and unchanged nodes as they are', async () => {
        const a = (await check({ 'a.dt': 'context A {\n  value V { x: Int y: String }\n}\n' })).model!;
        const b = (await check({ 'a.dt': 'context A {\n  value V { x: Int z: Bool }\n}\n' })).model!;
        const g = buildStructureGraph(b);
        expect(markLineChanges(g, undefined)).toBe(g);
        expect(markLineChanges(g, buildStructureGraph(b)).nodes).toEqual(g.nodes);
        const v = markLineChanges(g, buildStructureGraph(a)).nodes.find((n) => n.id === 'A.V')!;
        expect(v.lines.map((l) => [l.key.en.name, l.change])).toEqual([
            ['x', undefined],
            ['y', 'removed'],
            ['z', 'added'],
        ]);
        expect(v.height).toBe(g.nodes.find((n) => n.id === 'A.V')!.height + 21);
    });
});
