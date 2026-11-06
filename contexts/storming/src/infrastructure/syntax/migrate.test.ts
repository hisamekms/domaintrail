import { describe, expect, test } from 'bun:test';
import { migrateStorming } from './migrate.js';

describe('migrateStorming (ADR 0032)', () => {
    test('rewrites `actor` and `target` of a command, lists and all, and nothing else', () => {
        const text = 'storming S {\n  actor A actor B\n  command C { actor A, B /* who */ target G emits E }\n}\n';
        const m = migrateStorming(text);
        expect(m.text).toBe('storming S {\n  actor A actor B\n  command C { by A, B /* who */ handledBy G emits E }\n}\n');
        expect(m.rewrites).toEqual([
            { line: 3, column: 15, from: 'actor', to: 'by', element: 'C', targets: ['A', 'B'] },
            { line: 3, column: 36, from: 'target', to: 'handledBy', element: 'C', targets: ['G'] },
        ]);
        expect(m.left).toEqual([]);
    });

    test('lists what it cannot rewrite, and leaves a file that does not parse as it is', () => {
        const odd = migrateStorming('storming S {\n  hotspot H { target G }\n}\n');
        expect(odd.text).toBe('storming S {\n  hotspot H { target G }\n}\n');
        expect(odd.left.map((l) => [l.line, l.column])).toEqual([[2, 15]]);
        expect(odd.left[0]!.message).toContain("`target G` in hotspot 'H'");
        const broken = migrateStorming('storming S {\n  event from\n}\n');
        expect(broken.rewrites).toEqual([]);
        expect(broken.left[0]).toMatchObject({ line: 2, column: 9 });
        expect(broken.left[0]!.message).toStartWith('does not parse, nothing rewritten:');
    });
});
