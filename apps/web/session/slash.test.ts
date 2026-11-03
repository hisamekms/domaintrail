// What `/` lists in the composer: the commands first (for who may start one), the templates by what is open and
// selected, filtered by ID and by the name in the UI language; a template picked; a running interview's messages in Solo.
import { describe, expect, test } from 'bun:test';
import type { MessageTemplateBody } from '@domaintrail/collaboration/protocol';
import { interviewSlot } from './interview';
import { slashItems, slashQuery, templateContexts, templateValue, type SlashScope } from './slash';

const commandNames = { es: 'ES を始める', model: 'モデリングを始める' } as const;
const storming = (level: string): SlashScope['view'] => ({ kind: 'storming', level });
const event: SlashScope['selected'] = {
    target: { target: { kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' }, label: '返品が依頼された' },
    kind: { language: 'dtes', kind: 'event' },
    mention: '返品が依頼された',
};
const aggregate: SlashScope['selected'] = {
    target: { target: { kind: 'DtElement', element: 'Sales.Order' }, label: '注文' },
    kind: { language: 'dt', kind: 'aggregate' },
    mention: '注文',
};
const ids = (input: Partial<Parameters<typeof slashItems>[0]>): string[] =>
    slashItems({ query: '', lang: 'ja', scope: { view: { kind: 'model' } }, commandNames, canStart: true, ...input }).map((i) => `${i.kind}:${i.id}`);

describe('/ in the composer', () => {
    test('only `/` and its query, alone in the text, opens it', () => {
        expect(slashQuery('/')).toBe('');
        expect(slashQuery('/es')).toBe('es');
        expect(slashQuery('/es more')).toBeUndefined();
        expect(slashQuery('see /es')).toBeUndefined();
        expect(slashQuery('a/b')).toBeUndefined();
    });

    test('the contexts: the storming and its level, a .dt view, the selection and its kind', () => {
        expect([...templateContexts({ view: storming('big-picture') })]).toEqual(['storming', 'big-picture', 'none']);
        expect([...templateContexts({ view: storming('design-level'), selected: event })]).toEqual(['storming', 'design-level', 'element', 'event']);
        expect([...templateContexts({ view: { kind: 'model' }, selected: aggregate })]).toEqual(['model', 'element', 'aggregate']);
        const state = { target: { target: { kind: 'DtElement' as const, element: 'Sales.Order#Draft' } } };
        expect(templateContexts({ view: { kind: 'model' }, selected: state }).has('state')).toBe(true);
    });

    test('commands first, then the templates of what is open and selected; none for who cannot start one', () => {
        expect(ids({ scope: { view: storming('big-picture') } })).toEqual(['command:es', 'command:model', 'template:next-events', 'template:hotspots']);
        expect(ids({ scope: { view: storming('design-level'), selected: event } })).toEqual([
            'command:es',
            'command:model',
            'template:around',
            'template:hotspots',
            'template:commands',
            'template:explain',
        ]);
        expect(ids({ scope: { view: { kind: 'model' }, selected: aggregate }, canStart: false })).toEqual([
            'template:invariants',
            'template:states',
            'template:explain',
            'template:review',
        ]);
    });

    test('filtering matches the ID and the name in the UI language', () => {
        expect(ids({ query: 'es' })).toEqual(['command:es']);
        expect(ids({ query: 'モデ' })).toEqual(['command:model']);
        expect(ids({ query: 'model', lang: 'en', commandNames: { es: 'Start event storming', model: 'Start modeling' } })).toEqual(['command:model']);
        expect(ids({ query: 'issues', lang: 'en' })).toEqual(['template:review']);
        expect(ids({ query: '気になる' })).toEqual(['template:review']);
        expect(ids({ query: 'zzz' })).toEqual([]);
    });

    test("the team's templates come after the built-in ones, in the UI language, where they are offered", () => {
        const team: MessageTemplateBody[] = [
            { id: 'glossary', name: { ja: '用語を確かめる', en: 'Check the terms' }, text: '用語集と食い違うところを挙げて', when: ['model'] },
            { id: 'es-only', name: 'ES only', text: 'x', when: ['storming'] },
        ];
        expect(ids({ team })).toEqual(['command:es', 'command:model', 'template:review', 'template:glossary']);
        const [glossary] = slashItems({ query: 'glossary', lang: 'en', scope: { view: { kind: 'model' } }, commandNames, canStart: false, team });
        expect(glossary).toMatchObject({ kind: 'template', name: 'Check the terms', template: { team: true } });
    });

    test('a template picked: its text, the selection as the `#` target where it says {target}', () => {
        const [around] = slashItems({ query: 'around', lang: 'ja', scope: { view: storming('big-picture'), selected: event }, commandNames, canStart: true });
        if (around.kind !== 'template') throw new Error('a template');
        expect(templateValue(around.template, 'ja', event)).toEqual({
            text: '#返品が依頼された[1] の前後を詰めて',
            chips: [{ target: event?.target, mentioned: true }],
            people: [],
        });
        expect(templateValue(around.template, 'en', event).text).toBe('Fill in what happens before and after #返品が依頼された[1]');
        const [next] = slashItems({ query: 'next', lang: 'ja', scope: { view: storming('big-picture') }, commandNames, canStart: true });
        if (next.kind !== 'template') throw new Error('a template');
        expect(templateValue(next.template, 'ja', undefined)).toEqual({ text: 'このあとに起きることを足して', chips: [], people: [] });
    });

    test("Solo: an interview's message has the AI's question under it, or waits for it", () => {
        const at = (m: number) => `2026-11-03T09:0${m}:00.000Z`;
        const msg = (id: string, author: string, m: number, replyTo?: string) =>
            ({ id, author, sentAt: at(m), ...(replyTo && { replyTo: { kind: 'Message', request: replyTo } }) }) as never;
        const interview = { id: 'i', startedBy: 'me', opening: 'o', startedAt: at(1), state: 'Asking', awaiting: 'a2' } as never;
        const state = { interviews: [interview], requests: [msg('o', 'me', 1), msg('q1', 'ai', 2, 'o'), msg('a2', 'me', 3), msg('x', 'you', 3)] };
        expect(interviewSlot(state, { id: 'o', author: 'me' })).toEqual({ kind: 'answer', answer: 'q1' });
        expect(interviewSlot(state, { id: 'a2', author: 'me' })).toEqual({ kind: 'pending' });
        expect(interviewSlot(state, { id: 'x', author: 'you' })).toBeUndefined();
        const briefed = { ...state, interviews: [{ ...(interview as object), state: 'Briefed', answered: 'a2' }] } as never;
        expect(interviewSlot(briefed, { id: 'a2', author: 'me' })).toBe('none');
        expect(interviewSlot(state, { id: 'q1', author: 'ai' })).toBeUndefined();
    });
});
