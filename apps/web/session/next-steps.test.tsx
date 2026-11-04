// A suggested command's button (next-steps.tsx): disabled while one of its kind runs, putting `/` and the command's ID
// in the composer; and a candidate card's chips: only the elements that exist (one to be added is named by its label
// and how).
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '@domaintrail/analysis';
import { MESSAGES } from '../i18n';
import { actKinds, decides, exampleSources } from '../test-helpers';
import { CandidatesCard } from './candidates';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { TargetNamingProvider } from './naming';
import { commandButton, commandComposerValue } from './next-steps';
import { slashQuery } from './slash';
import type { NamingContext } from './targets';

const t = MESSAGES.ja;
const at = '2026-11-03T09:00:00.000Z';

let naming: NamingContext;
beforeAll(async () => {
    const a = await analyze(await exampleSources());
    naming = { mode: 'label', model: a.model ?? null, stormings: a.stormings.stormings.map((s) => ({ id: s.id, storming: s })) };
});

function chat(me: 'f' | 'bob', slashCommands: unknown[] = [], put: (id: string) => void = () => {}): ChatContextValue {
    return {
        tx: t.session,
        session: {
            status: 'live',
            me: { participant: { id: me, role: me === 'f' ? 'facilitator' : 'participant' } },
            state: { session: { state: 'Open', mode: 'Collab' }, slashCommands, requests: [], runs: [] },
        },
        onNavigate: () => {},
        nameOf: (id: string) => id,
        putCommand: put,
    } as unknown as ChatContextValue;
}

const render = (node: React.ReactNode, value: ChatContextValue): string =>
    renderToStaticMarkup(
        <TargetNamingProvider value={naming}>
            <ChatProvider value={value}>{node}</ChatProvider>
        </TargetNamingProvider>,
    );

describe("a suggested command's button", () => {
    test('everyone has it; one of a kind running is disabled', () => {
        expect(commandButton({}, 'es:exceptions')).toBe('enabled');
        expect(commandButton({}, 'model:start')).toBe('enabled');
        expect(commandButton({ slashCommands: [{ kind: 'EsExceptions', state: 'Listed' }] } as never, 'es:exceptions')).toBe('disabled');
        expect(commandButton({ interviews: [{ state: 'Asking' }] } as never, 'es:start')).toBe('disabled');
    });

    test("it puts `/` and the command's ID in the composer: `/`'s list opens on that command", () => {
        expect(commandComposerValue('es:gaps')).toEqual({ text: '/es:gaps', chips: [], people: [] });
        expect(slashQuery(commandComposerValue('es:gaps').text)).toBe('es:gaps');
    });
});

describe("a candidate's chips", () => {
    test('only the elements that exist: one to be added is not shown by its identifier; the reason names elements as links', () => {
        const command = {
            id: 'c2',
            kind: 'EsExceptions',
            state: 'Listed',
            scope: 'Returns',
            startedBy: 'f',
            opening: 'o',
            startedAt: at,
            candidates: [
                {
                    label: 'マイナンバーカードがなかった',
                    targets: [
                        { kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' },
                        { kind: 'DtesElement', storming: 'Returns', local: 'NoMyNumberCard' },
                    ],
                    how: '依頼から: カードがなかった',
                    reason: '@{es:Returns/ReturnRequested} の前に起きる',
                },
            ],
        } as never;
        const html = render(<CandidatesCard command={command} continues={false} />, chat('f', [command]));
        expect(html).toContain('マイナンバーカードがなかった');
        expect(html).not.toContain('#NoMyNumberCard');
        expect(html.match(/class="chat-chip chat-target proposal-target"/g)).toHaveLength(1);
        // an element the reason names is its name (a link), not the raw reference
        expect(html).not.toContain('@{es:Returns/ReturnRequested}');
    });
});

describe("a candidate command's card, by who looks", () => {
    const listed = (startedBy: string) =>
        ({
            id: 'c3',
            kind: 'EsExceptions',
            state: 'Listed',
            scope: 'Returns',
            startedBy,
            opening: 'o',
            startedAt: at,
            candidates: [{ label: '在庫がなかった', targets: [], how: '依頼から: 在庫なし' }],
        }) as never;
    const buttons = (html: string): string[] =>
        [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => (m[1] ?? '').replace(/<svg.*?<\/svg>/g, '').trim());

    test("the facilitator checks and applies a participant's candidates (the approval)", () => {
        const html = render(<CandidatesCard command={listed('bob')} continues={false} />, chat('f', [listed('bob')]));
        expect(html).toContain('type="checkbox"');
        expect(buttons(html)).toEqual(['採用したものを反映', '中止']);
        // 反映 changes the files: the one decide; 中止 stops (docs/ui-rules.md)
        expect(actKinds(html)).toEqual(['decide', 'stop']);
        expect(decides(html)).toBe(1);
        expect(html).not.toContain('ファシリテーターが選んで反映します');
    });

    test('a participant reads them, its starter too: no checkbox, no apply, one muted line; its starter may stop it', () => {
        const starter = render(<CandidatesCard command={listed('bob')} continues={false} />, chat('bob', [listed('bob')]));
        expect(starter).not.toContain('type="checkbox"');
        expect(starter).toContain('<p class="candidates-line muted">ファシリテーターが選んで反映します</p>');
        expect(buttons(starter)).toEqual(['中止']);
        // the facilitator's own command: a participant reads it, and cannot stop it
        const other = render(<CandidatesCard command={listed('f')} continues={false} />, chat('bob', [listed('f')]));
        expect(other).not.toContain('type="checkbox"');
        expect(buttons(other)).toEqual([]);
    });
});
