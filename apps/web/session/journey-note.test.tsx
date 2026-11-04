// The buttons of dt's note after a brief is confirmed (journey-note.tsx): the next step's command (into the composer, as
// the guide's), the source storming to show, 「旅程を開く」; none on a message without a note; no command button once the
// session is over.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { JourneyNoteActions } from './journey-note';
import { TargetNamingProvider } from './naming';
import type { NamingContext } from './targets';

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
    test('the next command into the composer, then 旅程を開く', () => {
        const html = render({ journeyNote: { journey: 'es:Issue', command: 'EsExceptions', targets: [] } });
        expect(html).toMatch(/<button[^>]*class="chat-small primary guide-command"[^>]*>.*?\/es:exceptions<\/button>/);
        expect(html).toMatch(/class="chat-small guide-go"[^>]*>.*?lucide-compass.*?旅程を開く<\/button>/);
        // the session over: only 旅程を開く
        expect(render({ journeyNote: { journey: 'es:Issue', command: 'EsExceptions', targets: [] } }, chat(false))).not.toContain('guide-command');
    });

    test('the source storming to show; nothing for a message without a note', () => {
        const html = render({ journeyNote: { journey: 'issuance', targets: [{ kind: 'DtesStorming', storming: 'Issue' }] } });
        expect(html).not.toContain('guide-command');
        expect(html).toContain('lucide-eye');
        expect(html).toContain('Issue');
        expect(render({})).toBe('');
    });
});
