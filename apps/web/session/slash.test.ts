// What `/` lists in the composer: the commands first (all, for everyone; one of a running kind disabled), the templates by what is open and
// selected, filtered by ID and by the name in the UI language; a template picked; a running interview's messages in Solo;
// which command may start now; the hint's button and the marks of what it suggests.
import { describe, expect, test } from 'bun:test';
import type { MessageTemplateBody } from '@domaintrail/collaboration/protocol';
import { interviewSlot } from './interview';
import { commandSlot } from './candidates';
import { streamItems } from './stream';
import { MESSAGES } from '../i18n';
import {
    canStartCommand,
    COMMAND_IDS,
    hintButton,
    hintSuggestions,
    slashItems,
    slashQuery,
    templateContexts,
    templateValue,
    type CommandId,
    type SlashScope,
} from './slash';

const commandNames = MESSAGES.ja.session.chat.slash.commands;
const everyone = (): boolean => true;
const ES = ['es:start', 'es:exceptions', 'es:gaps', 'es:levels', 'es:names', 'es:recap'].map((id) => `command:${id}`);
const COMMANDS = ['command:hint', ...ES, 'command:model:start'];
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
    slashItems({ query: '', lang: 'ja', scope: { view: { kind: 'model' } }, commandNames, canStart: everyone, ...input }).map((i) => `${i.kind}:${i.id}`);

describe('/ in the composer', () => {
    test('only `/` and its query, alone in the text, opens it', () => {
        expect(slashQuery('/')).toBe('');
        expect(slashQuery('/es')).toBe('es');
        expect(slashQuery('/es:exceptions')).toBe('es:exceptions');
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

    test('commands first (the hint, then grouped by prefix with :start first), then the templates of what is open and selected', () => {
        // the hint (where a beginner starts), es:start, the other ES commands in the order of the work (the flow, its
        // details, the session), model:start
        expect(COMMAND_IDS).toEqual(['hint', 'es:start', 'es:exceptions', 'es:gaps', 'es:levels', 'es:names', 'es:recap', 'model:start']);
        expect(ids({ scope: { view: storming('big-picture') } })).toEqual([...COMMANDS, 'template:next-events', 'template:hotspots']);
        expect(ids({ scope: { view: storming('design-level'), selected: event } })).toEqual([
            ...COMMANDS,
            'template:around',
            'template:hotspots',
            'template:commands',
            'template:explain',
        ]);
        // one that cannot start now (one of its kind runs) is still listed, disabled
        const none = slashItems({ query: '', lang: 'ja', scope: { view: { kind: 'model' } }, commandNames, canStart: (id) => id !== 'es:gaps' });
        expect(none.filter((i) => i.kind === 'command' && i.disabled).map((i) => i.id)).toEqual(['es:gaps']);
        expect(ids({ scope: { view: { kind: 'model' }, selected: aggregate }, canStart: () => false })).toEqual([
            ...COMMANDS,
            'template:invariants',
            'template:states',
            'template:explain',
            'template:review',
        ]);
    });

    test('filtering matches the ID and the name in the UI language', () => {
        // `/es` lists every ES command, `/es:start` first
        expect(ids({ query: 'es' })).toEqual(ES);
        expect(ids({ query: 'es:e' })).toEqual(['command:es:exceptions']);
        expect(ids({ query: 'モデ' })).toEqual(['command:model:start']);
        expect(ids({ query: 'まとめ' })).toEqual(['command:es:recap']);
        expect(ids({ query: '名前' })).toEqual(['command:es:names']);
        expect(ids({ query: 'ヒント' })).toEqual(['command:hint']);
        expect(ids({ query: 'hint' })).toEqual(['command:hint']);
        // the former ID lists nothing
        expect(ids({ query: 'es:next' })).toEqual([]);
        // a command put in the composer by a step of /hint (`/es:gaps`): its query lists it alone
        expect(ids({ query: slashQuery('/es:gaps') ?? '' })).toEqual(['command:es:gaps']);
        const en = MESSAGES.en.session.chat.slash.commands;
        expect(ids({ query: 'model', lang: 'en', commandNames: en })).toEqual(['command:model:start']);
        expect(ids({ query: 'exceptions', lang: 'en', commandNames: en })).toEqual(['command:es:exceptions']);
        expect(ids({ query: 'gaps', lang: 'en', commandNames: en })).toEqual(['command:es:gaps']);
        expect(ids({ query: 'a hint', lang: 'en', commandNames: en })).toEqual(['command:hint']);
        expect(ids({ query: 'issues', lang: 'en' })).toEqual(['template:review']);
        expect(ids({ query: '気になる' })).toEqual(['template:review']);
        expect(ids({ query: 'zzz' })).toEqual([]);
    });

    test("the team's templates come after the built-in ones, in the UI language, where they are offered", () => {
        const team: MessageTemplateBody[] = [
            { id: 'glossary', name: { ja: '用語を確かめる', en: 'Check the terms' }, text: '用語集と食い違うところを挙げて', when: ['model'] },
            { id: 'es-only', name: 'ES only', text: 'x', when: ['storming'] },
        ];
        expect(ids({ team })).toEqual([...COMMANDS, 'template:review', 'template:glossary']);
        const [glossary] = slashItems({ query: 'glossary', lang: 'en', scope: { view: { kind: 'model' } }, commandNames, canStart: () => false, team });
        expect(glossary).toMatchObject({ kind: 'template', name: 'Check the terms', template: { team: true } });
    });

    test('a template picked: its text, the selection as the `#` target where it says {target}', () => {
        const [around] = slashItems({
            query: 'around',
            lang: 'ja',
            scope: { view: storming('big-picture'), selected: event },
            commandNames,
            canStart: everyone,
        });
        if (around.kind !== 'template') throw new Error('a template');
        expect(templateValue(around.template, 'ja', event)).toEqual({
            text: '#返品が依頼された[1] の前後を詰めて',
            chips: [{ target: event?.target, mentioned: true }],
            people: [],
        });
        expect(templateValue(around.template, 'en', event).text).toBe('Fill in what happens before and after #返品が依頼された[1]');
        expect(ids({ query: 'next', scope: { view: storming('big-picture') } })).toEqual(['template:next-events']);
        const [next] = slashItems({ query: 'next', lang: 'ja', scope: { view: storming('big-picture') }, commandNames, canStart: () => false });
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

describe('which command may start now', () => {
    const can = (state: object): readonly CommandId[] => COMMAND_IDS.filter((id) => canStartCommand(state as never, id));

    test('any command, for everyone, while none of its kind runs', () => {
        expect(can({})).toEqual(COMMAND_IDS);
    });

    test('the hint button: hidden with no answerer, disabled while a hint runs (anyone may press it)', () => {
        expect(hintButton({}, true)).toBe('ready');
        expect(hintButton({}, false)).toBe('hidden');
        expect(hintButton({ slashCommands: [{ kind: 'Hint', state: 'Working' }] } as never, true)).toBe('disabled');
        expect(hintButton({ slashCommands: [{ kind: 'Hint', state: 'Answered' }] } as never, true)).toBe('ready');
        // an interview running does not hold it up
        expect(hintButton({ interviews: [{ state: 'Asking' }] } as never, true)).toBe('ready');
    });

    test('the commands the latest answered hint suggests: by their IDs, until another hint is answered', () => {
        const hint = (id: string, state: string, commands: (string | undefined)[] = []) =>
            ({
                id,
                kind: 'Hint',
                state,
                ...(state === 'Answered' && {
                    next: { status: 's', steps: commands.map((command) => ({ text: 't', reason: 'r', ...(command && { command }) })) },
                }),
            }) as never;
        expect([...hintSuggestions({})]).toEqual([]);
        expect([...hintSuggestions({ slashCommands: [hint('a', 'Answered', ['EsGaps', undefined, 'ModelStart'])] })]).toEqual(['es:gaps', 'model:start']);
        // a newer hint answered takes over; one still working or stopped does not
        const both = [hint('a', 'Answered', ['EsGaps']), hint('b', 'Answered', ['EsRecap'])];
        expect([...hintSuggestions({ slashCommands: both })]).toEqual(['es:recap']);
        expect([...hintSuggestions({ slashCommands: [...both, hint('c', 'Working'), hint('d', 'Stopped')] })]).toEqual(['es:recap']);
        // another answer command's answer is no hint
        expect([...hintSuggestions({ slashCommands: [{ id: 'r', kind: 'EsRecap', state: 'Answered', answer: 'x' } as never] })]).toEqual([]);
    });

    test('none while an interview runs; a command not while one of its kind runs', () => {
        expect(can({ interviews: [{ state: 'Asking' }] })).toEqual(COMMAND_IDS.filter((id) => !id.endsWith(':start')));
        expect(can({ slashCommands: [{ kind: 'EsExceptions', state: 'Listed' }] })).toEqual(COMMAND_IDS.filter((id) => id !== 'es:exceptions'));
        expect(
            can({
                slashCommands: [
                    { kind: 'EsExceptions', state: 'Applied' },
                    { kind: 'EsRecap', state: 'Working' },
                ],
            }),
        ).toEqual(COMMAND_IDS.filter((id) => id !== 'es:recap'));
    });
});

describe("a command's place in the chat", () => {
    const at = (m: number) => `2026-11-03T09:0${m}:00.000Z`;
    const command = (kind: string, state: string, more: object = {}) => ({ id: `c-${kind}`, kind, state, opening: 'o', startedAt: at(2), ...more }) as never;

    test("Solo: an answer command's answer under its message, pending meanwhile; a candidate command's card instead", () => {
        expect(commandSlot({ slashCommands: [command('EsRecap', 'Working')] }, { id: 'o' })).toEqual({ kind: 'pending' });
        expect(commandSlot({ slashCommands: [command('EsRecap', 'Answered', { answer: 'a' })] }, { id: 'o' })).toEqual({ kind: 'answer', answer: 'a' });
        expect(commandSlot({ slashCommands: [command('EsExceptions', 'Working')] }, { id: 'o' })).toBe('none');
        expect(commandSlot({ slashCommands: [command('EsExceptions', 'Working')] }, { id: 'x' })).toBeUndefined();
    });

    test("the stream: a candidate command's card always; an answer command's only while it works, in Collab", () => {
        const keys = (mode: string, commands: never[]): string[] =>
            streamItems({ runs: [], revisions: [], requests: [], slashCommands: commands, session: { mode } as never }).map((i) => i.key);
        expect(keys('Collab', [command('EsExceptions', 'Applied'), command('EsRecap', 'Working')])).toEqual(['command:c-EsExceptions', 'command:c-EsRecap']);
        expect(keys('Collab', [command('EsRecap', 'Answered')])).toEqual([]);
        expect(keys('Solo', [command('EsRecap', 'Working')])).toEqual([]);
        // a hint stored listed with none (an `/es:next` started with no storming in view, read as a Hint): the card says
        // so until its starter closes it
        expect(keys('Solo', [command('Hint', 'Listed', { candidates: [] })])).toEqual(['command:c-Hint']);
        expect(commandSlot({ slashCommands: [command('Hint', 'Listed', { candidates: [] })] }, { id: 'o' })).toBe('none');
        expect(keys('Solo', [command('Hint', 'Stopped')])).toEqual([]);
    });
});
