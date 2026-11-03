// The `/` commands' table and the answerer's output for them (candidates or an answer) read as untrusted AI output:
// clamped where a proposal's options are, refused where its text is; the interviews' IDs, the former ones still read.
import { describe, expect, test } from 'bun:test';
import { commandId, interviewCommandOf } from './interviews.js';
import {
    candidateData,
    chosenIndices,
    commandJsonSchema,
    readCommandReply,
    SLASH_COMMAND_NAMES,
    slashCommandName,
    slashCommandOf,
    stormingInView,
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
        expect(SLASH_COMMAND_NAMES).toEqual(['es:exceptions', 'es:recap']);
        expect(slashCommandOf('es:exceptions')).toEqual({ kind: 'EsExceptions', type: 'candidates', facilitatorOnly: true, needsStorming: true });
        expect(slashCommandOf('es:recap')).toEqual({ kind: 'EsRecap', type: 'answer', facilitatorOnly: false, needsStorming: false });
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

    test('the schema of each type, and the numbers chosen (each once, in order, all listed)', () => {
        expect(commandJsonSchema('answer')).toMatchObject({ required: ['kind', 'answer'] });
        expect(commandJsonSchema('candidates')).toMatchObject({ properties: { candidates: { maxItems: 12 } } });
        const listed = [candidate('a'), candidate('b'), candidate('c')] as never[];
        expect(chosenIndices(listed, [2, 0, 2]) as unknown).toEqual([0, 2]);
        expect(chosenIndices(listed, [3])).toBeUndefined();
        expect(chosenIndices(listed, [])).toBeUndefined();
    });
});
