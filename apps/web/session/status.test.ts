import { describe, expect, test } from 'bun:test';
import { MESSAGES } from '../i18n';
import { cancelPrompt, runningLabel, slotLabels, turnState } from './status';

const ja = MESSAGES.ja.session.chat;
const en = MESSAGES.en.session.chat;

describe('turnState', () => {
    test('shows the state only where nothing else does', () => {
        expect(turnState({ kind: 'queued' })).toBe('queued');
        expect(turnState({ kind: 'running', since: '2026-10-31T09:00:00.000Z' })).toBe('running');
        expect(turnState({ kind: 'failed', reason: 'AgentError' })).toBe('failed');
        expect(turnState({ kind: 'cancelled', by: 'p1' })).toBe('cancelled');
        expect(turnState({ kind: 'clarification', question: 'q', result: undefined, files: undefined })).toBeUndefined();
        expect(turnState({ kind: 'completed', changed: true, result: 1, files: 1 } as never)).toBeUndefined();
    });
});

describe('slotLabels', () => {
    test("has the word of each state a turn shows and a running turn's with its time", () => {
        const labels = slotLabels(ja.marks);
        expect(labels).toContain('実行待ち');
        expect(labels).toContain('失敗');
        expect(labels).toContain(runningLabel(ja.marks, '00:00'));
        expect(runningLabel(ja.marks, '12:34')).toBe('実行中 12:34');
        expect(slotLabels(en.marks)).toContain('cancelled');
    });
    test('leaves out what the slot never shows (a question, done), so that it is no wider than it needs', () => {
        expect(slotLabels(ja.marks)).not.toContain('確認待ち');
        expect(slotLabels(en.marks)).not.toContain('awaiting an answer');
        expect(slotLabels(en.marks)).not.toContain('done');
    });
});

describe('cancelPrompt', () => {
    test('a running run: its work so far is lost', () => {
        expect(cancelPrompt('Running', ja.cancelDialog)).toEqual({ title: '実行を取り消しますか？', lost: 'ここまでの作業は反映されません' });
        expect(cancelPrompt('Running', en.cancelDialog)).toEqual({ title: 'Cancel the run?', lost: 'Its work so far will not be applied' });
    });
    test('a queued run: the request is cancelled, nothing lost', () => {
        expect(cancelPrompt('Queued', ja.cancelDialog)).toEqual({ title: '依頼を取り消しますか？', lost: undefined });
        expect(cancelPrompt('Queued', en.cancelDialog)).toEqual({ title: 'Cancel the request?', lost: undefined });
    });
    test('a run that ended cannot be cancelled', () => {
        for (const state of ['Completed', 'NeedsClarification', 'Declined', 'Failed', 'Cancelled'] as const)
            expect(cancelPrompt(state, ja.cancelDialog)).toBeUndefined();
    });
});
