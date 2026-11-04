// An interview's choices in the chat (interview.tsx): shown under the question the interview awaits, to its starter only
// and only until it is answered (also after a reload: they come with the interview in the session's state); one choice
// pressed is sent at once as a reply to the question, several are checked and sent joined, and その他 always comes last
// and goes to the composer. The brief's card by who looks: the facilitator confirms their own or approves (or rejects)
// a participant's; the others read it with 承認待ち.
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { check } from '../test-helpers';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { TargetNamingProvider } from './naming';
import { MentionedText } from './parts';
import type { NamingContext } from './targets';
import {
    awaitedChoices,
    briefRole,
    choiceAnswerBody,
    ChoiceList,
    InterviewChoices,
    InterviewPanel,
    joinChoices,
    rejectedOfMine,
    type ChoiceListProps,
} from './interview';
import { Act } from '../shared/act';

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

/** The text of an element's children (a choice's as written: `ChoiceText`'s `text`). */
function textOf(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (!isValidElement<{ children?: ReactNode; text?: unknown }>(node)) return '';
    return typeof node.props.text === 'string' ? node.props.text : textOf(node.props.children);
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
    const buttons = tree.filter((e) => e.type === 'button' || e.type === Act);
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
        expect(none.buttons.map((b) => b.props.kind)).toEqual(['send', 'open']);
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

describe('a choice that names an element by reference', () => {
    // a storming with a label, one without, and a context with a label
    const naming = async (mode: NamingContext['mode'] = 'label'): Promise<NamingContext> => {
        const a = await check({
            'konbini.dtes': 'storming ConvenienceStoreIssuance "住民票などのコンビニ交付（ビッグピクチャ）" {\n  event Issued "交付した"\n}\n',
            'bare.dtes': 'storming Bare {\n  event Done\n}\n',
            'billing.dt': 'context Billing "請求" {\n}\n',
        });
        return { mode, model: a.model ?? null, stormings: a.stormings.stormings.map((s) => ({ id: s.id, storming: s })) };
    };
    const choices = ['@{es:ConvenienceStoreIssuance}', '@{es:Bare}', '@{Billing}', '@{es:Gone}', '@{es:ConvenienceStoreIssuance/Issued} から'];
    const html = (ctx: NamingContext, more: Partial<ChoiceListProps> = {}): string =>
        renderToStaticMarkup(<TargetNamingProvider value={ctx}>{list({ choices, ...more }).tree[0]}</TargetNamingProvider>);
    /** The buttons' (or the checkboxes' labels') texts, as shown. */
    const shown = (markup: string): string[] =>
        // the single ones: send buttons (送る, after the checkboxes, opens with its icon); the several: labels
        [
            ...markup.matchAll(
                /<(?:button[^>]*class="act act-send"[^>]*>(?!<svg)|label[^>]*class="interview-choice(?:| checked)"[^>]*>)(.*?)<\/(?:button|label)>/gu,
            ),
        ].map((m) => (m[1] ?? '').replace(/<[^>]+>/gu, ''));

    test('shows the label, else the name; a missing one as written, as messages do; never a link', async () => {
        const ctx = await naming();
        const single = html(ctx);
        expect(shown(single)).toEqual(['住民票などのコンビニ交付（ビッグピクチャ）', 'Bare', '請求', 'Gone', '交付した から']);
        expect(single).toContain('<span class="choice-text"><span class="reply-element">住民票などのコンビニ交付（ビッグピクチャ）</span></span>');
        expect(single).toContain('<span class="reply-element unresolved">Gone</span>');
        expect(single).not.toContain('<a');
        expect(single).not.toContain('@{');
        // the display setting, as for messages
        expect(shown(html(await naming('name')))[0]).toBe('ConvenienceStoreIssuance');
        // checkboxes: the same
        expect(shown(html(ctx, { multiple: true }))).toEqual(['住民票などのコンビニ交付（ビッグピクチャ）', 'Bare', '請求', 'Gone', '交付した から']);
    });

    test('sends the reference as written, so the AI gets the ID; several joined keep theirs', () => {
        const single = list({ choices });
        click(single.buttons[0]);
        expect(single.sent).toEqual(['@{es:ConvenienceStoreIssuance}']);
        expect(choiceAnswerBody('q1', single.sent[0] ?? '').body).toBe('@{es:ConvenienceStoreIssuance}');
        const several = list({ choices, multiple: true, checked: new Set([0, 2]) });
        click(several.buttons[0]);
        expect(several.sent).toEqual(['@{es:ConvenienceStoreIssuance}、@{Billing}']);
    });

    test("the person's message with the choice shows the label, as a link like any reference", async () => {
        const ctx = await naming();
        const markup = renderToStaticMarkup(
            <TargetNamingProvider value={ctx}>
                <MentionedText body="@{es:ConvenienceStoreIssuance}" targets={[]} statuses={[]} onNavigate={() => {}} tx={t.session} />
            </TargetNamingProvider>,
        );
        expect(markup).toBe('<a class="reply-element">住民票などのコンビニ交付（ビッグピクチャ）</a>');
    });
});

describe("the brief's subject", () => {
    test('a storming and a context by their labels, as links show them, not their IDs', async () => {
        const a = await check({
            'konbini.dtes': 'storming ConvenienceStoreIssuance "住民票などのコンビニ交付" {\n  event Issued "交付した"\n}\n',
            'billing.dt': 'context Billing "請求" {\n}\n',
        });
        const ctx: NamingContext = { mode: 'label', model: a.model ?? null, stormings: a.stormings.stormings.map((s) => ({ id: s.id, storming: s })) };
        const briefOf = (journey: Record<string, unknown>): unknown =>
            interview({
                startedBy: 'f',
                state: 'Briefed',
                asked: undefined,
                brief: { name: 'm', label: 'モデル', isNew: true, replaces: false, text: '目的: x', journey: { stormings: [], ...journey } },
                answered: 'a1',
                briefedAt: at,
            });
        const howFar = (i: unknown): string => {
            const session = {
                status: 'live',
                me: { participant: { id: 'f', role: 'facilitator' } },
                state: { session: { state: 'Open', mode: 'Solo' }, interviews: [i], requests: [], runs: [] },
            };
            const html = renderToStaticMarkup(
                <TargetNamingProvider value={ctx}>
                    <ChatProvider value={{ tx: t.session, session } as unknown as ChatContextValue}>
                        <InterviewPanel session={session as never} live />
                    </ChatProvider>
                </TargetNamingProvider>,
            );
            return (/<p class="chat-brief-howfar">(.*?)<\/p>/u.exec(html)?.[1] ?? '').replace(/<[^>]+>/gu, '');
        };
        const fromStorming = howFar(briefOf({ pattern: 'FromStorming', goal: 'invariants', stormings: ['ConvenienceStoreIssuance'] }));
        expect(fromStorming).toContain('ES「住民票などのコンビニ交付」');
        expect(fromStorming).not.toContain('ConvenienceStoreIssuance');
        expect(howFar(briefOf({ pattern: 'OneContext', goal: 'invariants', context: 'Billing' }))).toContain('請求');
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

describe("the brief's card, by who looks", () => {
    const brief = { name: 'Returns', label: '返品', isNew: true, replaces: false, text: '目的: 返金を早める\n範囲: 申請から返金まで' };
    const briefed = (startedBy: string) => interview({ startedBy, state: 'Briefed', asked: undefined, brief, answered: 'a1', briefedAt: at });
    const panel = (me: string, i: unknown): string => {
        const role = me === 'f' ? 'facilitator' : 'participant';
        const session = {
            status: 'live',
            me: { participant: { id: me, role } },
            state: { session: { state: 'Open', mode: 'Collab' }, interviews: [i], requests: [], runs: [] },
        };
        return renderToStaticMarkup(
            <ChatProvider value={{ tx: t.session, session } as unknown as ChatContextValue}>
                <InterviewPanel session={session as never} live />
            </ChatProvider>,
        );
    };
    const buttons = (html: string): string[] =>
        [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => (m[1] ?? '').replace(/<svg.*?<\/svg>/g, '').trim());

    test("a participant's brief: the facilitator approves, edits and approves, or rejects it", () => {
        expect(briefRole({ startedBy: 'bob' }, { id: 'f', role: 'facilitator' }, true)).toBe('approve');
        expect(buttons(panel('f', briefed('bob')))).toEqual(['承認', '編集して承認', '却下']);
    });

    test('its starter (a participant) sees 承認待ち and may stop it; another participant reads it', () => {
        const starter = panel('bob', briefed('bob'));
        expect(starter).toContain('承認待ち');
        expect(starter).toContain('目的');
        expect(buttons(starter)).toEqual(['中止']);
        const other = panel('carol', briefed('bob'));
        expect(other).toContain('承認待ち');
        expect(buttons(other)).toEqual([]);
        expect(briefRole({ startedBy: 'bob' }, { id: 'bob', role: 'participant' }, true)).toBe('wait');
    });

    test("the facilitator's own brief: 確定 / 編集して確定 / 中止, as before; participants wait for it", () => {
        expect(buttons(panel('f', briefed('f')))).toEqual(['確定', '編集して確定', '中止']);
        expect(buttons(panel('bob', briefed('f')))).toEqual([]);
    });

    test('while it asks, its starter and the facilitator may stop it', () => {
        expect(buttons(panel('bob', interview({ startedBy: 'bob' })))).toEqual(['中止']);
        expect(buttons(panel('f', interview({ startedBy: 'bob' })))).toEqual(['中止']);
        expect(buttons(panel('carol', interview({ startedBy: 'bob' })))).toEqual([]);
    });

    test('rejected: its starter is told so, with the note; nobody else', () => {
        const rejected = interview({ startedBy: 'bob', state: 'Rejected', asked: undefined, brief, rejectedBy: 'f', note: '範囲が広すぎます', rejectedAt: at });
        expect(rejectedOfMine(state(rejected), 'bob')).toMatchObject({ note: '範囲が広すぎます' });
        const html = panel('bob', rejected);
        expect(html).toContain('却下されました');
        expect(html).toContain('範囲が広すぎます');
        expect(panel('f', rejected)).toBe('');
    });
});
