import { describe, expect, test } from 'bun:test';
import { linesWithEnds, merge3, reverseChanges, undoableChanges, undoChanges, undoStatus, type UndoRun } from './undo.js';

const texts = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o));

describe('merge3', () => {
    test('takes the change of the side that changed a region', () => {
        expect(merge3('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n')).toBe('a\nB\nc\n');
        expect(merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n')).toBe('a\nb\nC\n');
    });

    test('takes changes of both sides in regions apart', () => {
        expect(merge3('1\n2\n3\n4\n5\n', 'one\n2\n3\n4\n5\n', '1\n2\n3\n4\nfive\n')).toBe('one\n2\n3\n4\nfive\n');
    });

    test('takes the same change once', () => {
        expect(merge3('a\nb\n', 'a\nX\n', 'a\nX\n')).toBe('a\nX\n');
    });

    test('a region both sides changed differently, or touching changes, is a conflict', () => {
        expect(merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n')).toBeUndefined();
        expect(merge3('a\nb\n', 'A\nb\n', 'a\nB\n')).toBeUndefined();
    });

    test('keeps the line ends as they are, the last line without one too', () => {
        expect(merge3('a\r\nm\r\nb', 'a\r\nm\r\nb\nc', 'A\r\nm\r\nb')).toBe('A\r\nm\r\nb\nc');
        expect(linesWithEnds('')).toEqual([]);
        expect(linesWithEnds('x\ny')).toEqual(['x\n', 'y']);
    });
});

describe('reverseChanges', () => {
    const base = texts({ 'a.dt': 'one\ntwo\nthree\n', 'gone.dt': 'removed by the run\n', 'same.dt': 'untouched\n' });
    const result = texts({ 'a.dt': 'one\nTWO\nthree\n', 'new.dt': 'added by the run\n', 'same.dt': 'untouched\n' });

    test('writes the base back where the workspace still has the result: changed, added (removed) and removed (back)', () => {
        const merged = reverseChanges(base, result, result);
        expect(merged).toEqual({
            kind: 'merged',
            write: texts({ 'a.dt': 'one\ntwo\nthree\n', 'gone.dt': 'removed by the run\n' }),
            remove: ['new.dt'],
        });
    });

    test('keeps a later change of another region of a file the run changed, and the files it did not change', () => {
        const current = texts({ 'a.dt': 'zero\none\nTWO\nthree\nfour\n', 'new.dt': 'added by the run\n', 'same.dt': 'edited later\n', 'later.dt': 'x\n' });
        const merged = reverseChanges(base, result, current);
        expect(merged.kind).toBe('merged');
        if (merged.kind !== 'merged') return;
        expect(merged.write.get('a.dt')).toBe('zero\none\ntwo\nthree\nfour\n');
        expect(merged.write.has('same.dt')).toBe(false);
        expect(merged.write.has('later.dt')).toBe(false);
        expect(merged.remove).toEqual(['new.dt']);
    });

    test('a later change of the lines the run changed, or of a file it added, or a file it changed removed since, is a conflict', () => {
        expect(reverseChanges(base, result, texts({ ...Object.fromEntries(result), 'a.dt': 'one\nTWO!\nthree\n' }))).toEqual({
            kind: 'conflict',
            paths: ['a.dt'],
        });
        expect(reverseChanges(base, result, texts({ ...Object.fromEntries(result), 'new.dt': 'added by the run\nand edited\n' }))).toEqual({
            kind: 'conflict',
            paths: ['new.dt'],
        });
        const removed = new Map(result);
        removed.delete('a.dt');
        expect(reverseChanges(base, result, removed)).toEqual({ kind: 'conflict', paths: ['a.dt'] });
    });

    test('a file the run removed and someone wrote again differently is a conflict; written again as it was, nothing to do', () => {
        expect(reverseChanges(base, result, texts({ ...Object.fromEntries(result), 'gone.dt': 'other\n' }))).toEqual({ kind: 'conflict', paths: ['gone.dt'] });
        expect(reverseChanges(base, result, base)).toEqual({ kind: 'nothing' });
    });
});

describe('undo status', () => {
    const run = (id: string, state: string, undoes?: string, revisions: { base?: string; result?: string } = {}): UndoRun => ({
        id,
        state,
        ...(revisions.base && { baseRevision: revisions.base }),
        ...(revisions.result && { resultRevision: revisions.result }),
        input: { requests: [{ ...(undoes && { undoes }) }] },
    });

    test('a run can be undone when it ended with a result other than its base', () => {
        expect(undoableChanges(run('r', 'Completed', undefined, { base: 'b', result: 'c' }))).toEqual({ base: 'b', result: 'c' });
        expect(undoableChanges(run('r', 'Failed', undefined, { base: 'b', result: 'c' }))).toEqual({ base: 'b', result: 'c' });
        expect(undoableChanges(run('r', 'Completed', undefined, { base: 'b', result: 'b' }))).toBeUndefined();
        expect(undoableChanges(run('r', 'Cancelled', undefined, { base: 'b' }))).toBeUndefined();
        expect(undoableChanges(run('r', 'Running', undefined, { base: 'b' }))).toBeUndefined();
    });

    test('undone by a mechanical undo or a completed AI undo; pending while one waits; none once it failed', () => {
        const target = run('r', 'Completed', undefined, { base: 'b', result: 'c' });
        expect(undoStatus(target, [target]).kind).toBe('none');
        expect(undoStatus(target, [target, run('u', 'Queued', 'r')]).kind).toBe('pending');
        expect(undoStatus(target, [target, run('u', 'Failed', 'r')]).kind).toBe('none');
        expect(undoStatus(target, [target, run('u', 'Reverted', 'r')])).toEqual({ kind: 'undone', by: run('u', 'Reverted', 'r') });
        expect(undoStatus(target, [target, run('u', 'Completed', 'r')]).kind).toBe('undone');
    });

    test('an undo undone in turn gives the run its changes back', () => {
        const target = run('r', 'Completed', undefined, { base: 'b', result: 'c' });
        expect(undoStatus(target, [target, run('u', 'Reverted', 'r'), run('v', 'Reverted', 'u')]).kind).toBe('none');
    });
});

describe('undoChanges', () => {
    test("gives each file's diff while the budget lasts, then its line counts", () => {
        const diff = (unified: string) => ({ kind: 'diff' as const, unified, added: 1, removed: 1, truncated: false });
        const changes = undoChanges(
            [
                { path: 'a.dt', status: 'changed', diff: diff('@@ -1,1 +1,1 @@\n-a\n+b') },
                { path: 'b.dt', status: 'changed', diff: diff(`@@ -1,1 +1,1 @@\n-${'x'.repeat(100)}\n+y`) },
            ],
            60,
        );
        expect(changes.diffsOmitted).toBe(true);
        expect(changes.files[0]).toEqual({ path: 'a.dt', status: 'changed', diff: '--- a/a.dt\n+++ b/a.dt\n@@ -1,1 +1,1 @@\n-a\n+b\n' });
        expect(changes.files[1]).toEqual({ path: 'b.dt', status: 'changed', added: 1, removed: 1 });
    });
});
