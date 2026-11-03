// An interview's choices in the chat (interview.tsx): shown under the question the interview awaits, to its starter only
// and only until it is answered (also after a reload: they come with the interview in the session's state); one choice
// pressed is sent at once as a reply to the question, several are checked and sent joined, and その他 always comes last
// and goes to the composer.
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { awaitedChoices, choiceAnswerBody, ChoiceList, InterviewChoices, joinChoices, type ChoiceListProps } from './interview';

const t = MESSAGES.ja;
const at = '2026-11-03T09:00:00.000Z';

const interview = (more: object = {}) =>
    ({
        id: 'i1',
        session: 's',
        command: 'Es',
        startedBy: 'f',
        opening: 'o',
        language: 'Ja',
        startedAt: at,
        state: 'Asking',
        asked: { question: 'q1', choices: ['返品', '交換', '修理'], multiple: false },
        ...more,
    }) as never;

const state = (i: unknown) => ({ interviews: [i] }) as never;

describe('which choices show', () => {
    test("under the question awaited, to its starter on a live page; the session's state (as reloaded) carries them", () => {
        expect(awaitedChoices(state(interview()), 'q1', 'f', true)).toEqual({ question: 'q1', choices: ['返品', '交換', '修理'], multiple: false });
        const multiple = interview({ asked: { question: 'q1', choices: ['PO', '開発者'], multiple: true } });
        expect(awaitedChoices(state(multiple), 'q1', 'f', true)).toMatchObject({ multiple: true });
    });

    test('none for the others, a closed page, another message, once answered, without choices, or once briefed', () => {
        expect(awaitedChoices(state(interview()), 'q1', 'bob', true)).toBeUndefined();
        expect(awaitedChoices(state(interview()), 'q1', 'f', false)).toBeUndefined();
        expect(awaitedChoices(state(interview()), 'q0', 'f', true)).toBeUndefined();
        // answered: the interview waits for the AI again (the choices were dropped with it)
        expect(awaitedChoices(state(interview({ awaiting: 'a1', asked: undefined })), 'q1', 'f', true)).toBeUndefined();
        expect(awaitedChoices(state(interview({ awaiting: 'a1' })), 'q1', 'f', true)).toBeUndefined();
        expect(awaitedChoices(state(interview({ asked: { question: 'q1', choices: [], multiple: false } })), 'q1', 'f', true)).toBeUndefined();
        expect(awaitedChoices(state(interview({ state: 'Briefed', asked: undefined })), 'q1', 'f', true)).toBeUndefined();
        expect(awaitedChoices({ interviews: [] } as never, 'q1', 'f', true)).toBeUndefined();
    });
});

/** The elements of a tree, depth first. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement<Record<string, unknown>>(node)) return [];
    return [node, ...elements(node.props.children as ReactNode)];
}

/** The text of an element's children. */
function textOf(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : '';
}

function list(more: Partial<ChoiceListProps> = {}) {
    const sent: string[] = [];
    const toggled: number[] = [];
    let other = 0;
    const props: ChoiceListProps = {
        choices: ['返品', '交換', '修理'],
        multiple: false,
        checked: new Set(),
        busy: false,
        lang: 'ja',
        tx: t.session.chat.interview.choices,
        onToggle: (i) => toggled.push(i),
        onSend: (text) => sent.push(text),
        onOther: () => {
            other += 1;
        },
        ...more,
    };
    const tree = elements(ChoiceList(props));
    const buttons = tree.filter((e) => e.type === 'button');
    return { sent, toggled, other: () => other, tree, buttons, html: renderToStaticMarkup(<ChoiceList {...props} />) };
}

function click(e: ReactElement<Record<string, unknown>> | undefined): void {
    if (!e) throw new Error('no such button');
    (e.props.onClick as () => void)();
}

describe('the choices', () => {
    test('single: a button per choice that sends it at once; その他 last, to the composer', () => {
        const l = list();
        expect(l.buttons.map((b) => textOf(b.props.children as ReactNode))).toEqual(['返品', '交換', '修理', 'その他（自分で書く）']);
        expect(l.tree.some((e) => e.type === 'input')).toBe(false);
        click(l.buttons[1]);
        expect(l.sent).toEqual(['交換']);
        click(l.buttons.at(-1));
        expect(l.other()).toBe(1);
        expect(l.sent).toEqual(['交換']);
        expect(l.html).toContain('class="interview-choices" role="group" aria-label="答えの選択肢"');
    });

    test('multiple: checkboxes and 送る (disabled until one is checked), the checked ones sent joined in their order', () => {
        const none = list({ multiple: true });
        expect(none.tree.filter((e) => e.type === 'input' && e.props.type === 'checkbox')).toHaveLength(3);
        expect(none.buttons.map((b) => b.props.className)).toEqual(['interview-choice send', 'interview-choice other']);
        expect(none.buttons[0].props.disabled).toBe(true);
        const input = none.tree.find((e) => e.type === 'input');
        if (!input) throw new Error('no checkbox');
        (input.props.onChange as () => void)();
        expect(none.toggled).toEqual([0]);

        const two = list({ multiple: true, checked: new Set([2, 0]) });
        expect(two.buttons[0].props.disabled).toBe(false);
        click(two.buttons[0]);
        expect(two.sent).toEqual(['返品、修理']);
        expect(two.html).toContain('class="interview-choice checked"');
        click(two.buttons[1]);
        expect(two.other()).toBe(1);
        expect(joinChoices(['PO', 'Dev'], 'en')).toBe('PO, Dev');
    });

    test('while sending, nothing can be pressed; the text of a choice is shown as text', () => {
        const busy = list({ busy: true });
        expect(busy.buttons.every((b) => b.props.disabled === true)).toBe(true);
        expect(list({ choices: ['<b>A</b>', 'B'] }).html).toContain('&lt;b&gt;A&lt;/b&gt;');
    });

    test('an answer is a message replying to the question', () => {
        expect(choiceAnswerBody('q1', '返品')).toEqual({ targets: [], body: '返品', replyTo: { kind: 'Message', request: 'q1' } });
    });
});

describe('under the message of the AI', () => {
    const chat = (me: string, i: unknown): ChatContextValue =>
        ({
            tx: t.session,
            session: {
                status: 'live',
                me: { participant: { id: me, role: me === 'f' ? 'facilitator' : 'participant' } },
                state: { session: { state: 'Open', mode: 'Collab' }, interviews: [i], requests: [], runs: [] },
            },
            focusComposer: () => {},
        }) as unknown as ChatContextValue;
    const render = (value: ChatContextValue, request = 'q1'): string =>
        renderToStaticMarkup(
            <ChatProvider value={value}>
                <InterviewChoices request={request} />
            </ChatProvider>,
        );

    test('its starter sees them; the others, another message, or after the answer: nothing', () => {
        expect(render(chat('f', interview()))).toContain('その他（自分で書く）');
        expect(render(chat('bob', interview()))).toBe('');
        expect(render(chat('f', interview()), 'q0')).toBe('');
        expect(render(chat('f', interview({ awaiting: 'a1', asked: undefined })))).toBe('');
    });
});
