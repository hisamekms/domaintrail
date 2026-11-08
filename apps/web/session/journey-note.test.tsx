// The buttons of dt's note after a brief is confirmed (journey-note.tsx): the next step's command (into the composer, as
// the guide's), the source storming to show, 「ジャーニーを開く」; none on a message without a note; no command button once the
// session is over.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { designLevelDraft, JourneyNoteActions } from './journey-note';
import { TargetNamingProvider } from './naming';
import type { NamingContext } from './targets';
import { actKinds, decides } from '../test-helpers';

const t = MESSAGES.ja;
const naming: NamingContext = { mode: 'label', model: null, stormings: [] };

function chat(live = true): ChatContextValue {
    return {
        journeys: { setOpen: () => {} },
        tx: t.session,
        session: {
            status: live ? 'live' : 'closed',
            me: { participant: { id: 'f', role: 'facilitator' } },
            state: {
                session: { state: live ? 'Open' : 'Closed', mode: 'Solo' },
                slashCommands: [],
                interviews: [],
                requests: [],
                runs: [],
                marks: [],
                revisions: [],
            },
        },
        onNavigate: () => {},
        putCommand: () => {},
    } as unknown as ChatContextValue;
}

const render = (request: object, value = chat()): string =>
    renderToStaticMarkup(
        <TargetNamingProvider value={naming}>
            <ChatProvider value={value}>
                <JourneyNoteActions request={{ id: 'n1', author: 'ai', body: 'x', ...request } as never} />
            </ChatProvider>
        </TargetNamingProvider>,
    );

describe("dt's note after a brief is confirmed", () => {
    test('the next command into the composer, then ジャーニーを開く', () => {
        const html = render({ journeyNote: { journey: 'es:Issue', command: 'EsExceptions', targets: [] } });
        expect(html).toMatch(/<button[^>]*class="act act-insert"[^>]*>.*?\/es:exceptions<\/button>/);
        expect(html).toMatch(/class="act act-open"[^>]*>.*?lucide-compass.*?ジャーニーを開く<\/button>/);
        // the session over: only ジャーニーを開く
        expect(render({ journeyNote: { journey: 'es:Issue', command: 'EsExceptions', targets: [] } }, chat(false))).not.toContain('act-insert');
    });

    test('the buttons by what they do (docs/ui-rules.md): the command inserted, the place seen, the panel opened; no decide', () => {
        const html = render({ journeyNote: { journey: 'es:Issue', command: 'EsExceptions', targets: [{ kind: 'DtesStorming', storming: 'Issue' }] } });
        expect(actKinds(html)).toEqual(['insert', 'see', 'open']);
        expect(decides(html)).toBe(0);
    });

    test('the source storming to show; nothing for a message without a note', () => {
        const html = render({ journeyNote: { journey: 'issuance', targets: [{ kind: 'DtesStorming', storming: 'Issue' }] } });
        expect(html).not.toContain('act-insert');
        expect(html).toContain('lucide-eye');
        expect(html).toContain('Issue');
        expect(render({})).toBe('');
    });

    test('DL invitation offers one flow, whole storming, custom scope and later; drafts ask for an actual edit', () => {
        const html = render({ journeyNote: { journey: 'es:Issue', targets: [], invitation: true } });
        for (const label of ['一つの流れ', '全体', '自由指定', 'あとで']) expect(html).toContain(label);
        expect(render({ journeyNote: { journey: 'es:Issue', targets: [], invitation: true } }, chat(false))).not.toContain('一つの流れ');
        for (const scope of ['flow', 'all', 'custom'] as const) {
            expect(designLevelDraft('Issue', scope, 'ja')).toContain('仮案を .dtes に描いてください');
            expect(designLevelDraft('Issue', scope, 'en')).toContain('Please edit the .dtes defining storming Issue');
        }
        expect(designLevelDraft('Issue', 'flow', 'ja')).toContain('［流れ名］');
    });
});
