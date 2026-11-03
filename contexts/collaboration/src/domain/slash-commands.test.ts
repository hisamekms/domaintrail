// The `/` commands' table and the answerer's output for them (candidates or an answer) read as untrusted AI output:
// clamped where a proposal's options are, refused where its text is; the interviews' IDs, the former ones still read.
import { describe, expect, test } from 'bun:test';
import { commandId, interviewCommandOf } from './interviews.js';
import {
    candidateData,
    chosenIndices,
    commandJsonSchema,
    nextAnswerData,
    nextAnswerText,
    readCommandReply,
    SLASH_COMMAND_NAMES,
    slashCommandName,
    slashCommandOf,
    stormingInView,
    suggestedCommandId,
} from './slash-commands.js';

const candidate = (label: string, more: object = {}): object => ({ label, targets: ['@{es:Orders/OrderPaid}'], how: `OrderPaid から: ${label}`, ...more });

describe('the commands and their IDs', () => {
    test('the interviews are es:start and model:start; the former es and model are read', () => {
        expect(commandId('Es')).toBe('es:start');
        expect(commandId('Model')).toBe('model:start');
        expect(['es:start', 'es', 'model:start', 'model', 'es:recap', 'toString', 1].map(interviewCommandOf)).toEqual([
            'Es',
            'Es',
            'Model',
            'Model',
            undefined,
            undefined,
            undefined,
        ]);
    });

    test('the other commands: their type and who starts them', () => {
        // the work on a storming in its order (the flow, then its details), then the session's
        expect(SLASH_COMMAND_NAMES).toEqual(['es:exceptions', 'es:gaps', 'es:levels', 'es:names', 'es:recap', 'es:next']);
        const candidates = { type: 'candidates', reply: 'candidates', facilitatorOnly: true, needsStorming: true } as const;
        expect(slashCommandOf('es:exceptions')).toEqual({ kind: 'EsExceptions', ...candidates });
        expect(slashCommandOf('es:gaps')).toEqual({ kind: 'EsGaps', ...candidates });
        expect(slashCommandOf('es:levels')).toEqual({ kind: 'EsLevels', ...candidates });
        expect(slashCommandOf('es:names')).toEqual({ kind: 'EsNames', ...candidates });
        expect(slashCommandOf('es:recap')).toEqual({ kind: 'EsRecap', type: 'answer', reply: 'answer', facilitatorOnly: false, needsStorming: false });
        // anyone's, about the storming in view, answered in a shape of its own
        expect(slashCommandOf('es:next')).toEqual({ kind: 'EsNext', type: 'answer', reply: 'next', facilitatorOnly: false, needsStorming: true });
        expect(slashCommandOf('es:start')).toBeUndefined();
        expect(slashCommandOf('constructor')).toBeUndefined();
        expect(slashCommandName('EsRecap')).toBe('es:recap');
    });

    test('the storming in view: the view, else the element selected', () => {
        const view = { view: { kind: 'Storming', storming: 'Orders', level: 'BigPicture', exceptions: false } } as never;
        expect(stormingInView(view, undefined) as unknown).toBe('Orders');
        expect(stormingInView(undefined, { kind: 'DtesElement', storming: 'Returns', local: 'X' } as never) as unknown).toBe('Returns');
        expect(stormingInView({ view: { kind: 'ContextMap', all: true } } as never, { kind: 'DtElement', element: 'Sales.Order' } as never)).toBeUndefined();
    });
});

describe("the answerer's candidates", () => {
    test('read with their references as a proposal reads them: a malformed one dropped, one not there yet kept', () => {
        const read = readCommandReply(
            {
                kind: 'candidates',
                candidates: [
                    candidate(' 支払いが失敗した ', {
                        how: 'OrderPaid から: 支払いが失敗した',
                        targets: ['@{es:Orders/OrderPaid}', 'orders.dtes', '@{es:Orders/PaymentFailed}'],
                        reason: '決済は外部',
                    }),
                ],
            },
            'candidates',
        );
        expect(read as unknown).toEqual({
            ok: true,
            value: {
                kind: 'candidates',
                candidates: [
                    {
                        label: '支払いが失敗した',
                        targets: [
                            { kind: 'DtesElement', storming: 'Orders', local: 'OrderPaid' },
                            { kind: 'DtesElement', storming: 'Orders', local: 'PaymentFailed' },
                        ],
                        how: 'OrderPaid から: 支払いが失敗した',
                        reason: '決済は外部',
                    },
                ],
            },
        });
        if (!read.ok || read.value.kind !== 'candidates') throw new Error('candidates');
        // sent again as read, it reads the same
        expect(readCommandReply({ kind: 'candidates', candidates: read.value.candidates.map(candidateData) }, 'candidates')).toEqual(read);
    });

    test('clamped to twelve; none is a list too; text past its limit, an unknown field or the other kind refused', () => {
        const many = readCommandReply({ kind: 'candidates', candidates: Array.from({ length: 15 }, (_, i) => candidate(`C${i}`)) }, 'candidates');
        expect((many.ok && many.value.kind === 'candidates' && many.value.candidates.map((c) => c.label)) as unknown).toEqual(
            Array.from({ length: 12 }, (_, i) => `C${i}`),
        );
        expect(readCommandReply({ kind: 'candidates', candidates: [] }, 'candidates')).toEqual({ ok: true, value: { kind: 'candidates', candidates: [] } });
        expect(readCommandReply({ kind: 'candidates', candidates: [candidate('x'.repeat(61))] }, 'candidates')).toMatchObject({
            ok: false,
            error: { path: 'reply.candidates[0].label' },
        });
        expect(readCommandReply({ kind: 'candidates', candidates: [candidate('a\nb')] }, 'candidates')).toMatchObject({ ok: false });
        expect(readCommandReply({ kind: 'candidates', candidates: [candidate('a', { file: 'x' })] }, 'candidates')).toMatchObject({
            ok: false,
            error: { path: 'reply.candidates[0].file' },
        });
        expect(readCommandReply({ kind: 'answer', answer: 'x' }, 'candidates')).toMatchObject({ ok: false, error: { path: 'reply.kind' } });
    });

    test('an answer: Markdown within the answers’ limit', () => {
        expect(readCommandReply({ kind: 'answer', answer: ' **決まったこと**\n- なし ' }, 'answer')).toEqual({
            ok: true,
            value: { kind: 'answer', answer: '**決まったこと**\n- なし' },
        });
        expect(readCommandReply({ kind: 'answer', answer: 'x'.repeat(5000) }, 'answer')).toMatchObject({ ok: false });
        expect(readCommandReply({ kind: 'candidates', candidates: [] }, 'answer')).toMatchObject({ ok: false });
    });

    test("/es:next's steps: read, clamped to three, one line each, an unknown command dropped; the message written from them", () => {
        const step = (text: string, more: object = {}): object => ({ text, reason: `${text} の理由`, ...more });
        const read = readCommandReply(
            {
                kind: 'next',
                status: ' Big Picture:\n発行まで ',
                steps: [step('例外を洗い出す', { command: 'es:exceptions' }), step('専門家に聞く'), step('揃える', { command: '/es:names' }), step('4つめ')],
            },
            'next',
        );
        expect(read as unknown).toEqual({
            ok: true,
            value: {
                kind: 'answer',
                answer: 'Big Picture: 発行まで\n\n1. **例外を洗い出す** — 例外を洗い出す の理由 `/es:exceptions`\n2. **専門家に聞く** — 専門家に聞く の理由\n3. **揃える** — 揃える の理由 `/es:names`',
                next: {
                    status: 'Big Picture: 発行まで',
                    steps: [
                        { text: '例外を洗い出す', reason: '例外を洗い出す の理由', command: 'EsExceptions' },
                        { text: '専門家に聞く', reason: '専門家に聞く の理由' },
                        { text: '揃える', reason: '揃える の理由', command: 'EsNames' },
                    ],
                },
            },
        });
        // a command the steps may not suggest (itself, a model one) is dropped, the step kept
        const odd = readCommandReply({ kind: 'next', status: 's', steps: [step('a', { command: 'es:next' }), step('b', { command: 'model:start' })] }, 'next');
        expect((odd.ok && odd.value.kind === 'answer' && odd.value.next?.steps) as unknown).toEqual([
            { text: 'a', reason: 'a の理由' },
            { text: 'b', reason: 'b の理由' },
        ]);
        expect(readCommandReply({ kind: 'next', status: 's', steps: [] }, 'next')).toMatchObject({ ok: false, error: { path: 'reply.steps' } });
        expect(readCommandReply({ kind: 'next', status: 's', steps: [step('x'.repeat(121))] }, 'next')).toMatchObject({
            ok: false,
            error: { path: 'reply.steps[0].text' },
        });
        expect(readCommandReply({ kind: 'next', status: 's', steps: [step('a', { file: 'x' })] }, 'next')).toMatchObject({
            ok: false,
            error: { path: 'reply.steps[0].file' },
        });
        expect(readCommandReply({ kind: 'next', status: 's', steps: [step('a')], answer: 'x' }, 'next')).toMatchObject({ ok: false });
        expect(readCommandReply({ kind: 'answer', answer: 'x' }, 'next')).toMatchObject({ ok: false, error: { path: 'reply.kind' } });
        // the answerer sends them as read, and the server reads them again to the same
        if (read.ok && read.value.kind === 'answer' && read.value.next) {
            const sent = nextAnswerData(read.value.next);
            expect(sent.steps[0]).toEqual({ text: '例外を洗い出す', reason: '例外を洗い出す の理由', command: 'es:exceptions' });
            expect(readCommandReply({ kind: 'next', ...sent }, 'next')).toEqual(read);
            expect(nextAnswerText(read.value.next)).toBe(read.value.answer);
        }
        expect(suggestedCommandId('EsStart')).toBe('es:start');
    });

    test('the schema of each type, and the numbers chosen (each once, in order, all listed)', () => {
        expect(commandJsonSchema('answer')).toMatchObject({ required: ['kind', 'answer'] });
        expect(commandJsonSchema('next')).toMatchObject({
            required: ['kind', 'status', 'steps'],
            properties: {
                steps: {
                    minItems: 1,
                    maxItems: 3,
                    items: { properties: { command: { enum: ['es:start', 'es:exceptions', 'es:gaps', 'es:levels', 'es:names', 'es:recap'] } } },
                },
            },
        });
        expect(commandJsonSchema('candidates')).toMatchObject({ properties: { candidates: { maxItems: 12 } } });
        const listed = [candidate('a'), candidate('b'), candidate('c')] as never[];
        expect(chosenIndices(listed, [2, 0, 2]) as unknown).toEqual([0, 2]);
        expect(chosenIndices(listed, [3])).toBeUndefined();
        expect(chosenIndices(listed, [])).toBeUndefined();
    });
});
