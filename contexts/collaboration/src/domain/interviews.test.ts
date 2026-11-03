// The interviewer's output (a question or a brief) read as untrusted AI output, a brief as the person edits it, and the
// team's templates as the config file has them.
import { describe, expect, test } from 'bun:test';
import { briefData, briefLines, interviewerJsonSchema, readBriefText, readInterviewerReply } from './interviews.js';
import { checkTemplates } from './templates.js';

const lines = [
    { head: '目的', text: '返金を早める' },
    { head: '範囲', text: '申請から返金まで' },
    { head: '使い道', text: 'モデリングへ' },
    { head: 'レベル', text: 'Big Picture' },
];

describe("the interviewer's reply", () => {
    test('a question, or a brief whose lines become its text (a new one replaces nothing)', () => {
        expect(readInterviewerReply({ kind: 'question', question: ' どの業務？ ' })).toEqual({ ok: true, value: { kind: 'question', question: 'どの業務？' } });
        const read = readInterviewerReply({ kind: 'brief', brief: { name: 'Returns', label: '返品', isNew: true, replaces: true, lines } });
        expect(read as unknown).toEqual({
            ok: true,
            value: {
                kind: 'brief',
                brief: {
                    name: 'Returns',
                    label: '返品',
                    isNew: true,
                    replaces: false,
                    text: '目的: 返金を早める\n範囲: 申請から返金まで\n使い道: モデリングへ\nレベル: Big Picture',
                },
            },
        });
        if (read.ok && read.value.kind === 'brief') expect(briefData(read.value.brief).lines).toEqual(lines);
    });

    test('refused: an unknown kind or field, a name that is no identifier, too few lines, a head with a colon, a line break', () => {
        const brief = (b: object) => readInterviewerReply({ kind: 'brief', brief: { name: 'Returns', isNew: false, replaces: true, lines, ...b } });
        expect(readInterviewerReply({ kind: 'answer', answer: 'x' })).toMatchObject({ ok: false, error: { path: 'reply.kind' } });
        expect(readInterviewerReply({ kind: 'question', question: 'x', extra: 1 })).toMatchObject({ ok: false, error: { path: 'reply.extra' } });
        expect(brief({ name: '返品' })).toMatchObject({ ok: false, error: { path: 'reply.brief.name' } });
        expect(brief({ lines: lines.slice(0, 2) })).toMatchObject({ ok: false, error: { path: 'reply.brief.lines' } });
        expect(brief({ lines: [{ head: '目的:', text: 'x' }, ...lines.slice(1)] })).toMatchObject({ ok: false, error: { path: 'reply.brief.lines[0].head' } });
        expect(brief({ lines: [{ head: '目的', text: 'a\nb' }, ...lines.slice(1)] })).toMatchObject({
            ok: false,
            error: { path: 'reply.brief.lines[0].text' },
        });
        expect(brief({})).toMatchObject({ ok: true, value: { brief: { replaces: true, isNew: false } } });
        expect(interviewerJsonSchema()).toMatchObject({ required: ['kind'], properties: { kind: { enum: ['question', 'brief'] } } });
    });

    test('an edited brief: lines trimmed, blank ones dropped; heads read back with either colon', () => {
        expect(readBriefText('  目的: A \n\n範囲：B\n', 'text') as unknown).toEqual({ ok: true, value: '目的: A\n範囲：B' });
        expect(readBriefText(' \n ', 'text')).toMatchObject({ ok: false });
        expect(readBriefText('x'.repeat(1600), 'text')).toMatchObject({ ok: false });
        expect(briefLines('目的: A\n範囲：B\nただの行')).toEqual([{ head: '目的', text: 'A' }, { head: '範囲', text: 'B' }, { text: 'ただの行' }]);
    });
});

describe("the team's templates (`templates`)", () => {
    test('one text or one per language; an ID, a name and a text; where it is offered', () => {
        const ok = [
            { id: 'glossary', name: { ja: '用語を確かめる', en: 'Check the terms' }, text: '用語集と食い違うところを挙げて', when: ['model', 'storming'] },
            { id: 'ask', name: 'Ask', text: { en: 'Explain {target}' } },
        ];
        expect(checkTemplates(ok) as unknown).toEqual({ ok: true, value: ok });
        expect(checkTemplates(undefined)).toEqual({ ok: true, value: [] });
    });

    test('refused with where: not an array, a bad or repeated ID, a missing text, an unknown language or context', () => {
        const t = (o: object) => ({ id: 'a', name: 'A', text: 'T', ...o });
        expect(checkTemplates({})).toEqual({ ok: false, error: "'templates' must be an array" });
        expect(checkTemplates([t({ id: 'Bad Id' })])).toMatchObject({ ok: false, error: expect.stringContaining("'templates[0].id'") });
        expect(checkTemplates([t({}), t({})])).toEqual({ ok: false, error: "'templates[1].id' repeats 'a'" });
        expect(checkTemplates([{ id: 'a', name: 'A' }])).toMatchObject({ ok: false, error: expect.stringContaining("'templates[0].text'") });
        expect(checkTemplates([t({ name: { fr: 'A' } })])).toMatchObject({
            ok: false,
            error: "unknown key 'templates[0].name.fr' (the languages are 'ja' and 'en')",
        });
        expect(checkTemplates([t({ when: ['board'] })])).toMatchObject({ ok: false, error: expect.stringContaining("'board'") });
        expect(checkTemplates([t({ extra: 1 })])).toEqual({ ok: false, error: "unknown key 'templates[0].extra'" });
    });
});
