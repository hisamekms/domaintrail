// `/hint` (ヒントをもらう) in the chat (hint.tsx): the composer's button (its label dropped when the bar is narrow,
// disabled while a hint runs), pressing it starts `/hint` at once; the light bulb on its answer; the star by a command it
// suggests.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StartCommandBody } from '@domaintrail/collaboration/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { HintButton, HintMark, startHint, SuggestedMark } from './hint';

const t = MESSAGES.ja.session.chat;
const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');

describe('the hint button', () => {
    test('a Lightbulb and its label; the tooltip and the aria-label always; an action, as tall as the send button', () => {
        const html = renderToStaticMarkup(<HintButton state="ready" busy={false} label={t.hint.button} onPress={() => {}} />);
        expect(html).toContain('class="chat-hint"');
        expect(html).toContain('aria-label="ヒントをもらう"');
        expect(html).toContain('data-tooltip="ヒントをもらう"');
        expect(html).toContain('lucide-lightbulb');
        expect(html).toContain('<span class="chat-hint-label">ヒントをもらう</span>');
        expect(html).not.toContain('disabled');
        expect(MESSAGES.en.session.chat.hint.button).toBe('Get a hint');
        // the brand on its pale wash; the send button's height
        expect(styles).toMatch(/button\.chat-hint \{[^}]*height: 26px;[^}]*background: var\(--brand-wash\);[^}]*color: var\(--brand\);/);
    });

    test('narrow: the icon only (the label hidden by a container query on the bar)', () => {
        expect(styles).toMatch(/\.chat-composer-bar \{\n\s+container: chat-composer-bar \/ inline-size;/);
        expect(styles).toMatch(/@container chat-composer-bar \(max-width: [\d.]+rem\) \{[^@]*\.chat-hint-label \{\s+display: none;/);
    });

    test('disabled while a hint runs, or while this page starts one', () => {
        for (const [state, busy] of [
            ['disabled', false],
            ['ready', true],
        ] as const)
            expect(renderToStaticMarkup(<HintButton state={state} busy={busy} label={t.hint.button} onPress={() => {}} />)).toContain('disabled=""');
    });

    test('pressed: /hint starts at once, its name the opening message, with the view and the selection', async () => {
        let pressed = 0;
        const button = HintButton({ state: 'ready', busy: false, label: t.hint.button, onPress: () => (pressed += 1) });
        (button.props as { onClick: () => void }).onClick();
        expect(pressed).toBe(1);
        const sent: StartCommandBody[] = [];
        const viewedAt = { view: { kind: 'ContextMap', all: true } } as never;
        await startHint({ startCommand: async (b) => sent.push(b) }, { body: t.slash.commands.hint, language: 'ja', viewedAt });
        expect(sent).toEqual([{ command: 'hint', body: 'ヒントをもらう', language: 'ja', viewedAt }]);
    });
});

describe("the hint's marks", () => {
    test('its answer: a light bulb by the AI name (ヒント)', () => {
        const html = renderToStaticMarkup(<HintMark label={t.hint.answer} />);
        expect(html).toContain('class="chat-hint-mark" role="img" aria-label="ヒント"');
        expect(html).toContain('lucide-lightbulb');
    });

    test("a command it suggests in `/`'s list: a filled amber star (ヒントのおすすめ)", () => {
        const html = renderToStaticMarkup(<SuggestedMark label={t.slash.suggested} />);
        expect(html).toContain('class="chat-slash-suggested" role="img" aria-label="ヒントのおすすめ" data-tooltip="ヒントのおすすめ"');
        expect(html).toContain('lucide-star');
        expect(styles).toMatch(/\.chat-slash-suggested svg \{\s+fill: currentColor;/);
        expect(styles).toMatch(/\.chat-slash-suggested \{[^}]*color: var\(--chat-hint-star\);/);
    });
});
