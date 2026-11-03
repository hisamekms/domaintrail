// A `/` command's opening message in the chat (command-chip.tsx): which messages are shown as the command's chip (read
// from the server's state, not the text), the chip's icon, `/` ID, name and accessible name, and the icons shared with
// `/`'s list.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { COMMAND_ICONS, CommandChip, CommandIcon } from './command-chip';
import { COMMAND_IDS, commandOfOpening, commandType, type CommandId } from './slash';

const t = MESSAGES.ja.session.chat.slash;
const at = '2026-01-01T00:00:00.000Z';
const state = {
    slashCommands: [
        { id: 'c1', kind: 'EsRecap', state: 'Answered', opening: 'r-recap', answer: 'a1', startedAt: at },
        { id: 'c2', kind: 'Guide', state: 'Working', opening: 'r-guide', startedAt: at },
        { id: 'c3', kind: 'EsExceptions', state: 'Listed', opening: 'r-exceptions', startedAt: at },
    ],
    interviews: [{ id: 'i1', command: 'Model', startedBy: 'me', state: 'Asking', opening: 'r-model', startedAt: at }],
} as never;

describe('which messages are a command opening', () => {
    test("a SlashCommand's or an Interview's opening request: its command", () => {
        expect(commandOfOpening(state, 'r-recap')).toBe('es:recap');
        expect(commandOfOpening(state, 'r-guide')).toBe('guide');
        expect(commandOfOpening(state, 'r-exceptions')).toBe('es:exceptions');
        expect(commandOfOpening(state, 'r-model')).toBe('model:start');
    });

    test("any other message is not, even one whose text is a command's name; a server before the commands has none", () => {
        expect(commandOfOpening(state, 'r-typed')).toBeUndefined();
        expect(commandOfOpening({} as never, 'r-recap')).toBeUndefined();
    });
});

describe('the chip', () => {
    const chip = (id: CommandId): string =>
        renderToStaticMarkup(<CommandChip id={id} name={t.commands[id]} description={t.types[commandType(id)]} label={t.chip(id, t.commands[id])} />);

    test('its icon, its `/` ID in monospace and its name; a button named コマンド /es:recap ここまでのまとめ, closed', () => {
        const html = chip('es:recap');
        expect(html).toContain('lucide-scroll-text');
        expect(html).toContain('<code class="chat-command-id">/es:recap</code>');
        expect(html).toContain('<span class="chat-command-name">ここまでのまとめ</span>');
        expect(html).toContain('aria-label="コマンド /es:recap ここまでのまとめ"');
        expect(html).toContain('aria-expanded="false"');
        // the description shows only once pressed
        expect(html).not.toContain(t.types.answer);
        expect(MESSAGES.en.session.chat.slash.chip('guide', 'Guide')).toBe('Command /guide Guide');
    });

    test('each command its icon', () => {
        expect(chip('guide')).toContain('lucide-compass');
        expect(chip('es:exceptions')).toContain('lucide-git-branch');
        expect(chip('es:start')).toContain('lucide-sparkles');
        expect(chip('model:start')).toContain('lucide-sparkles');
        expect(chip('es:gaps')).toContain('lucide-between-horizontal-start');
        expect(chip('es:levels')).toContain('lucide-layers');
        expect(chip('es:names')).toContain('lucide-tags');
    });
});

describe("the icons shared with `/`'s list", () => {
    test('every command listed has one', () => {
        for (const id of COMMAND_IDS) expect(COMMAND_ICONS[id]).toBeDefined();
        expect(renderToStaticMarkup(<CommandIcon id="es:recap" />)).toContain('chat-slash-icon');
    });

    test("`/`'s list draws a command's icon with the same component as the chip", () => {
        const chat = readFileSync(join(import.meta.dir, 'chat.tsx'), 'utf8');
        expect(chat).toContain("{c.kind === 'command' && <CommandIcon id={c.id} />}");
        expect(chat).not.toContain('<Sparkles');
    });
});
