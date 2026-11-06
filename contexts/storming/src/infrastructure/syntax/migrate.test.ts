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

    test('moves the `reads` of a command one policy issues into the policy, after its `on`, with its comments (ADR 0032 §9)', () => {
        const text = [
            'storming Dispatch {',
            '  event Cutoff',
            '  event Allocated',
            '  readmodel Requests',
            '  readmodel Drivers',
            '  aggregate Plan',
            '  command BuildAllocation "配車を組む" { // issued by a policy',
            '    // what is looked at',
            '    reads Requests // to decide',
            '    reads Drivers',
            '    handledBy Plan',
            '    emits Allocated',
            '  }',
            '  command Inline { reads Drivers handledBy Plan emits Allocated }',
            '  policy AtCutoff "2時" {',
            '    on Cutoff',
            '    // it issues',
            '    issues BuildAllocation',
            '  }',
            '  policy Quick { on Cutoff issues Inline }',
            '}',
            '',
        ].join('\n');
        const m = migrateStorming(text);
        expect(m.text).toBe(
            [
                'storming Dispatch {',
                '  event Cutoff',
                '  event Allocated',
                '  readmodel Requests',
                '  readmodel Drivers',
                '  aggregate Plan',
                '  command BuildAllocation "配車を組む" { // issued by a policy',
                '    handledBy Plan',
                '    emits Allocated',
                '  }',
                '  command Inline { handledBy Plan emits Allocated }',
                '  policy AtCutoff "2時" {',
                '    on Cutoff',
                '    // what is looked at',
                '    reads Requests // to decide',
                '    reads Drivers',
                '    // it issues',
                '    issues BuildAllocation',
                '  }',
                '  policy Quick { on Cutoff reads Drivers issues Inline }',
                '}',
                '',
            ].join('\n'),
        );
        expect(m.moves).toEqual([
            { line: 9, column: 5, command: 'BuildAllocation', policy: 'AtCutoff', targets: ['Requests'] },
            { line: 10, column: 5, command: 'BuildAllocation', policy: 'AtCutoff', targets: ['Drivers'] },
            { line: 14, column: 20, command: 'Inline', policy: 'Quick', targets: ['Drivers'] },
        ]);
        expect(m.left).toEqual([]);
        // a second run changes nothing
        expect(migrateStorming(m.text)).toEqual({ text: m.text, rewrites: [], moves: [], left: [] });
    });

    test("puts the moved `reads` before the policy's `issues` wherever that is, and never twice", () => {
        const text = 'storming S {\n  command C {\n    reads R, Q\n    emits E\n  }\n  policy P {\n    issues C\n    on E0\n    reads R\n  }\n}\n';
        const m = migrateStorming(text);
        // `issues` before `on` (not formatted): the `reads` goes before `issues`; R, which the policy reads already, is not repeated
        expect(m.text).toBe('storming S {\n  command C {\n    emits E\n  }\n  policy P {\n    reads Q\n    issues C\n    on E0\n    reads R\n  }\n}\n');
        expect(migrateStorming(m.text).text).toBe(m.text);
    });

    test('lists the `reads` of a command several policies issue, and a policy issuing several commands, without rewriting them', () => {
        const text = [
            'storming S {',
            '  command Reassign {',
            '    reads Drivers',
            '    handledBy Plan',
            '    emits Done',
            '  }',
            '  command Notify {',
            '    reads Inbox',
            '    emits Sent',
            '  }',
            '  command Hold {',
            '    by Clerk',
            '    reads Drivers',
            '    emits Held',
            '  }',
            '  policy OnFailure {',
            '    on Failed',
            '    issues Reassign',
            '  }',
            '  policy OnCancel {',
            '    on Cancelled',
            '    issues Reassign',
            '  }',
            '  policy Broad {',
            '    on Done',
            '    issues Notify, Hold',
            '  }',
            '}',
            '',
        ].join('\n');
        const m = migrateStorming(text);
        expect(m.text).toBe(text);
        expect(m.moves).toEqual([]);
        expect(m.left.map((l) => [l.line, l.column, l.message])).toEqual([
            [
                3,
                5,
                "`reads Drivers` in command 'Reassign', which the policies 'OnFailure' and 'OnCancel' issue: write it in the `reads` of the policy that looks at it, and remove it here (S030); it is not copied to each",
            ],
            [
                8,
                5,
                "`reads Inbox` in command 'Notify' not moved: policy 'Broad', which issues it, issues several commands (S031); split the policy first, then run this again",
            ],
            [
                26,
                5,
                "policy 'Broad' issues 'Notify' and 'Hold': a policy issues one command (S031); split it into one policy per command, each with the `reads` it looks at, then run this again (the `reads` of its commands are left where they are)",
            ],
        ]);
        // Hold has `by`: its `reads` is its issuer's, and stays (S025 is about its `by`)
        expect(migrateStorming(text).left).toEqual(m.left);
    });

    test('a command of v0.1 with `actor` keeps its `reads`; both migrations in one run', () => {
        const text =
            'storming S {\n  command A {\n    actor Clerk\n    reads R\n  }\n  command B {\n    target G\n    reads R\n  }\n  policy P {\n    on E\n    issues B\n  }\n}\n';
        const m = migrateStorming(text);
        expect(m.text).toBe(
            'storming S {\n  command A {\n    by Clerk\n    reads R\n  }\n  command B {\n    handledBy G\n  }\n  policy P {\n    on E\n    reads R\n    issues B\n  }\n}\n',
        );
        expect(m.rewrites.map((r) => r.to)).toEqual(['by', 'handledBy']);
        expect(m.moves.map((r) => [r.command, r.policy])).toEqual([['B', 'P']]);
        expect(migrateStorming(m.text).text).toBe(m.text);
    });
});
