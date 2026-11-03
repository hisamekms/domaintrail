// `/guide` (ガイド) in the chat (guide.tsx): the composer's button (its label dropped when the bar is narrow,
// disabled while a guide runs), pressing it starts `/guide` at once; the compass on its card; the star by a command it
// suggests.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StartCommandBody } from '@domaintrail/collaboration/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { GuideButton, GuideMark, startGuide, SuggestedMark } from './guide';

const t = MESSAGES.ja.session.chat;
const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');

describe('the guide button', () => {
    test('a Compass and its label; the tooltip and the aria-label always; an action, as tall as the send button', () => {
        const html = renderToStaticMarkup(<GuideButton state="ready" busy={false} label={t.guide.button} onPress={() => {}} />);
        expect(html).toContain('class="chat-guide"');
        expect(html).toContain('aria-label="ガイド"');
        expect(html).toContain('data-tooltip="ガイド"');
        expect(html).toContain('lucide-compass');
        expect(html).toContain('<span class="chat-guide-label">ガイド</span>');
        expect(html).not.toContain('disabled');
        expect(MESSAGES.en.session.chat.guide.button).toBe('Guide');
        // the brand on its pale wash; the send button's height
        expect(styles).toMatch(/button\.chat-guide \{[^}]*height: 26px;[^}]*background: var\(--brand-wash\);[^}]*color: var\(--brand\);/);
    });

    test('narrow: the icon only (the label hidden by a container query on the bar)', () => {
        expect(styles).toMatch(/\.chat-composer-bar \{\n\s+container: chat-composer-bar \/ inline-size;/);
        expect(styles).toMatch(/@container chat-composer-bar \(max-width: [\d.]+rem\) \{[^@]*\.chat-guide-label \{\s+display: none;/);
    });

    test('disabled while a guide runs, or while this page starts one', () => {
        for (const [state, busy] of [
            ['disabled', false],
            ['ready', true],
        ] as const)
            expect(renderToStaticMarkup(<GuideButton state={state} busy={busy} label={t.guide.button} onPress={() => {}} />)).toContain('disabled=""');
    });

    test('pressed: /hint starts at once, its name the opening message, with the view and the selection', async () => {
        let pressed = 0;
        const button = GuideButton({ state: 'ready', busy: false, label: t.guide.button, onPress: () => (pressed += 1) });
        (button.props as { onClick: () => void }).onClick();
        expect(pressed).toBe(1);
        const sent: StartCommandBody[] = [];
        const viewedAt = { view: { kind: 'ContextMap', all: true } } as never;
        await startGuide({ startCommand: async (b) => sent.push(b) }, { body: t.slash.commands.guide, language: 'ja', viewedAt });
        expect(sent).toEqual([{ command: 'guide', body: 'ガイド', language: 'ja', viewedAt }]);
    });
});

describe("the guide's marks", () => {
    test('its card: a compass by the AI name (ガイド)', () => {
        const html = renderToStaticMarkup(<GuideMark label={t.guide.answer} />);
        expect(html).toContain('class="chat-guide-mark" role="img" aria-label="ガイド"');
        expect(html).toContain('lucide-compass');
    });

    test("a command it suggests in `/`'s list: a filled amber star (ガイドのおすすめ)", () => {
        const html = renderToStaticMarkup(<SuggestedMark label={t.slash.suggested} />);
        expect(html).toContain('class="chat-slash-suggested" role="img" aria-label="ガイドのおすすめ" data-tooltip="ガイドのおすすめ"');
        expect(html).toContain('lucide-star');
        expect(styles).toMatch(/\.chat-slash-suggested svg \{\s+fill: currentColor;/);
        expect(styles).toMatch(/\.chat-slash-suggested \{[^}]*color: var\(--chat-guide-star\);/);
    });
});
