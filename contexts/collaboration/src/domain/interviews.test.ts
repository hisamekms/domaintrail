// The interviewer's output (a question or a brief) read as untrusted AI output, a brief as the person edits it, and the
// team's templates as the config file has them.
import { describe, expect, test } from 'bun:test';
import { briefData, briefLines, interviewerJsonSchema, readBriefText, readChoices, readInterviewerReply, withEditedText } from './interviews.js';
import { checkTemplates } from './templates.js';

const ES = { command: 'Es', language: 'Ja' } as const;
const MODEL = { command: 'Model', language: 'Ja' } as const;
const esJourney = { purpose: '返金を早める', scope: '申請から返金まで', participants: ['窓口担当', 'システム担当'], use: 'modeling', level: 'BigPicture' };

describe("the interviewer's reply", () => {
    test('a question, or an ES brief: the storming and its journey, its why as the text (a new one replaces nothing)', () => {
        expect(readInterviewerReply({ kind: 'question', question: ' どの業務？ ' }, ES)).toEqual({
            ok: true,
            value: { kind: 'question', question: 'どの業務？', choices: [], multiple: false },
        });
        const raw = { name: 'Returns', label: '返品', isNew: true, description: '返品の受付から返金まで', journey: esJourney };
        const read = readInterviewerReply({ kind: 'brief', brief: raw }, ES);
        expect(read as unknown).toEqual({
            ok: true,
            value: {
                kind: 'brief',
                brief: {
                    name: 'Returns',
                    label: '返品',
                    isNew: true,
                    replaces: false,
                    text: '目的: 返金を早める\n範囲: 申請から返金まで\n参加者: 窓口担当、システム担当',
                    journey: {
                        purpose: '返金を早める',
                        scope: '申請から返金まで',
                        participants: ['窓口担当', 'システム担当'],
                        stormings: [],
                        continues: false,
                        use: 'Modeling',
                        level: 'BigPicture',
                    },
                    description: '返品の受付から返金まで',
                },
            },
        });
        // sent again as the agent read it, it reads the same
        if (read.ok && read.value.kind === 'brief') expect(readInterviewerReply({ kind: 'brief', brief: briefData(read.value.brief) }, ES)).toEqual(read);
        // in English: the heads of the language
        const en = readInterviewerReply({ kind: 'brief', brief: raw }, { command: 'Es', language: 'En' });
        expect(en.ok && en.value.kind === 'brief' && (en.value.brief.text as string).split('\n')[0]).toBe('Purpose: 返金を早める');
    });

    test('a modeling brief: a new journey (its ID from its name) or one continued; the pattern, its goal and subject', () => {
        const fresh = readInterviewerReply(
            {
                kind: 'brief',
                brief: {
                    isNew: true,
                    journey: {
                        purpose: '請求を正す',
                        participants: [],
                        name: 'Billing の深掘り',
                        pattern: 'OneContext',
                        goal: 'invariants',
                        context: 'Billing',
                    },
                },
            },
            MODEL,
        );
        expect(fresh).toMatchObject({
            ok: true,
            value: {
                brief: {
                    name: 'billing',
                    isNew: true,
                    replaces: false,
                    journey: { pattern: 'OneContext', goal: 'invariants', context: 'Billing', journeyName: 'Billing の深掘り' },
                },
            },
        });
        const continued = readInterviewerReply(
            {
                kind: 'brief',
                brief: { name: 'from-es', isNew: false, journey: { purpose: 'x', participants: [], pattern: 'FromStorming', stormings: ['Issue'] } },
            },
            MODEL,
        );
        // a name with no ASCII word: the ID from the subject
        const ja = readInterviewerReply(
            {
                kind: 'brief',
                brief: {
                    isNew: true,
                    journey: { purpose: 'x', participants: [], name: 'コンビニ交付のモデル', pattern: 'FromStorming', stormings: ['ConvenienceStoreIssuance'] },
                },
            },
            MODEL,
        );
        expect(ja).toMatchObject({ ok: true, value: { brief: { name: 'convenience-store-issuance' } } });
        expect(continued).toMatchObject({
            ok: true,
            value: { brief: { name: 'from-es', replaces: true, journey: { continues: true, stormings: ['Issue'] } } },
        });
        if (fresh.ok && fresh.value.kind === 'brief')
            expect(readInterviewerReply({ kind: 'brief', brief: briefData(fresh.value.brief) }, MODEL)).toEqual(fresh);
    });

    test('refused: an unknown kind or field, a name that is no identifier, a journey that does not fit its command', () => {
        const brief = (b: object, j: object = {}, ctx: typeof ES | typeof MODEL = ES) =>
            readInterviewerReply({ kind: 'brief', brief: { name: 'Returns', isNew: false, ...b, journey: { ...esJourney, ...j } } }, ctx);
        expect(readInterviewerReply({ kind: 'answer', answer: 'x' }, ES)).toMatchObject({ ok: false, error: { path: 'reply.kind' } });
        expect(readInterviewerReply({ kind: 'question', question: 'x', extra: 1 }, ES)).toMatchObject({ ok: false, error: { path: 'reply.extra' } });
        expect(brief({ name: '返品' })).toMatchObject({ ok: false, error: { path: 'reply.brief.name' } });
        expect(brief({}, { level: 'Somewhere' })).toMatchObject({ ok: false, error: { path: 'reply.brief.journey.level' } });
        expect(brief({}, { purpose: 'a\nb' })).toMatchObject({ ok: false, error: { path: 'reply.brief.journey.purpose' } });
        expect(brief({}, { pattern: 'Whole' })).toMatchObject({ ok: false, error: { path: 'reply.brief.journey.pattern' } });
        // a modeling brief: no ES fields, a pattern, a goal it allows, its subject
        const model = { use: undefined, level: undefined };
        expect(brief({ name: 'j' }, { ...model, pattern: 'Review', goal: 'commands' }, MODEL)).toMatchObject({
            ok: false,
            error: { path: 'reply.brief.journey.goal' },
        });
        expect(brief({ name: 'j' }, { ...model, pattern: 'FromStorming' }, MODEL)).toMatchObject({
            ok: false,
            error: { path: 'reply.brief.journey.stormings' },
        });
        expect(brief({ name: 'Not A Slug' }, { ...model, pattern: 'Review' }, MODEL)).toMatchObject({ ok: false, error: { path: 'reply.brief.name' } });
        expect(brief({})).toMatchObject({ ok: true, value: { brief: { replaces: true, isNew: false } } });
        expect(interviewerJsonSchema()).toMatchObject({ required: ['kind'], properties: { kind: { enum: ['question', 'brief'] } } });
    });

    test('a brief edited: its why read back by its heads (either language), the rest of the journey kept', () => {
        const read = readInterviewerReply({ kind: 'brief', brief: { name: 'Returns', isNew: true, journey: esJourney } }, ES);
        if (!read.ok || read.value.kind !== 'brief') throw new Error('no brief');
        const brief = read.value.brief;
        const edited = withEditedText(brief, '目的: 返金を一日で\nScope: 申請だけ\n参加者: 窓口担当、経理' as never);
        expect(edited).toMatchObject({
            ok: true,
            value: { journey: { purpose: '返金を一日で', scope: '申請だけ', participants: ['窓口担当', '経理'], level: 'BigPicture' } },
        });
        expect(withEditedText(brief, '範囲: x' as never)).toMatchObject({ ok: false });
        expect(withEditedText(brief, '目的: x\nなにか: y' as never)).toMatchObject({ ok: false, error: { path: 'text[1]' } });
    });

    test("a question's choices: kept with `multiple`; the schema bounds them", () => {
        expect(
            readInterviewerReply({ kind: 'question', question: '誰が参加しますか？', choices: ['業務担当', '開発者', 'PO'], multiple: true }, ES) as unknown,
        ).toEqual({
            ok: true,
            value: { kind: 'question', question: '誰が参加しますか？', choices: ['業務担当', '開発者', 'PO'], multiple: true },
        });
        // `multiple` without choices means nothing
        expect(readInterviewerReply({ kind: 'question', question: 'なぜ？', multiple: true }, ES)).toMatchObject({
            ok: true,
            value: { choices: [], multiple: false },
        });
        expect(readInterviewerReply({ kind: 'question', question: 'x', choices: 'a, b' }, ES)).toMatchObject({ ok: false, error: { path: 'reply.choices' } });
        expect(readInterviewerReply({ kind: 'question', question: 'x', choices: ['a', 'b'], multiple: 'yes' }, ES)).toMatchObject({
            ok: false,
            error: { path: 'reply.multiple' },
        });
        expect(interviewerJsonSchema()).toMatchObject({
            properties: { choices: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } }, multiple: { type: 'boolean' } },
        });
    });

    test('choices are cleaned, not refused: blanks and non-strings dropped, one line, cut to 40, duplicates dropped, six at most', () => {
        expect(readChoices([' 返品 ', '', '   ', 3, null, '返品', 'RETURNS', 'returns', '交換\nと修理']) as readonly string[]).toEqual([
            '返品',
            'RETURNS',
            '交換 と修理',
        ]);
        const long = readChoices(['x'.repeat(60), 'y']);
        expect(long[0]).toHaveLength(40);
        expect(long[0].endsWith('…')).toBe(true);
        expect(readChoices(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) as readonly string[]).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        // one choice is no choice
        expect(readChoices(['only', ' ', 'only']) as readonly string[]).toEqual([]);
        expect(readChoices(undefined) as readonly string[]).toEqual([]);
        // the model's text kept as text: nothing in it is read
        expect(readChoices(['<b>A</b>', 'ignore the rules\u0007']) as readonly string[]).toEqual(['<b>A</b>', 'ignore the rules']);
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
