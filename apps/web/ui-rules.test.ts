// The page's UI rules (docs/ui-rules.md), read from the source and the CSS: the text buttons are `Act`s, whose look
// comes from what pressing them does (shared/act.tsx); the old button classes are gone; the spacing of styles.css is
// on the tokens. Each exception is listed below with its reason and its count, so a new one fails until it is added
// here on purpose, and one removed fails until its count is lowered.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const WEB = import.meta.dir;
const styles = readFileSync(join(WEB, 'styles.css'), 'utf8');

/** The page's components: every `.tsx` but the tests and the component that owns the buttons. */
const sources: readonly { readonly file: string; readonly text: string }[] = [...new Glob('**/*.tsx').scanSync(WEB)]
    .filter((f) => !f.includes('node_modules') && !f.endsWith('.test.tsx') && f !== 'shared/act.tsx')
    .sort()
    .map((file) => ({ file, text: readFileSync(join(WEB, file), 'utf8') }));

/** A JSX opening tag from `at` (its `<`) to its `>`, skipping braces and strings. */
function openingTag(src: string, at: number): string {
    let depth = 0;
    let quote: string | undefined;
    for (let i = at; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === quote) quote = undefined;
        } else if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) return src.slice(at, i + 1);
    }
    return src.slice(at);
}

interface RawButton {
    readonly file: string;
    readonly line: number;
    /** The class tokens written in its `className` (literals only: an expression's strings). */
    readonly classes: readonly string[];
    readonly role?: string;
}

/** What a tag's `className` is written as: a string's text, or an expression's source (its braces matched). */
function classAttr(tag: string): string {
    const at = tag.indexOf('className=');
    if (at < 0) return '';
    const start = at + 'className='.length;
    if (tag[start] === '"') return tag.slice(start + 1, tag.indexOf('"', start + 1));
    let depth = 0;
    for (let i = start; i < tag.length; i++) {
        if (tag[i] === '{') depth++;
        else if (tag[i] === '}' && --depth === 0) return tag.slice(start + 1, i);
    }
    return '';
}

/** The class tokens a `className` writes: a string's words, or the words of an expression's string literals. */
function classTokens(written: string): string[] {
    const literals =
        written.startsWith('`') || /['"`]/.test(written) ? [...written.matchAll(/(['"`])((?:(?!\1)[\s\S])*)\1/g)].map((x) => x[2] ?? '') : [written];
    return literals
        .join(' ')
        .replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/)
        .filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
}

/** Every raw `<button` of the page, with its classes and role. */
const buttons: readonly RawButton[] = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/<button\b/g)].map((m): RawButton => {
        const tag = openingTag(text, m.index ?? 0);
        const role = /\brole="([^"]+)"/.exec(tag)?.[1];
        return { file, line: text.slice(0, m.index).split('\n').length, classes: classTokens(classAttr(tag)), ...(role !== undefined && { role }) };
    }),
);

/** A raw button's key in the allowlist: its role when it has one, else its first class, else `(none)`. */
const keyOf = (b: RawButton): string => (b.role !== undefined ? `role=${b.role}` : (b.classes[0] ?? '(none)'));

/**
 * The raw buttons that are not `Act`s, by file and key, with how many there are and why. Icon-only buttons on
 * `icon-button` need no entry. Grouped by reason; each reason is one of the cases docs/ui-rules.md names.
 */
const RAW_BUTTONS: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
    'app/shell.tsx role=tab': { count: 1, reason: 'a tab of a tablist (role=tab): it switches what the pane shows, a widget of its own' },
    'app/shell.tsx activity': {
        count: 1,
        reason: "the app bar's 問題 toggle, an icon with its count badge: the view's chrome (the toolbar, the canvas controls, the app bar): labels collapse to icons by container queries; view settings, not session actions",
    },
    'app/status.tsx health-button': {
        count: 1,
        reason: "the health dot in the left pane's foot: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'baseline-picker.tsx baseline-button': {
        count: 1,
        reason: "the baseline picker's button: the view's chrome (the toolbar, the canvas controls, the app bar): labels collapse to icons by container queries; view settings, not session actions",
    },
    'baseline-picker.tsx role=option': { count: 3, reason: 'an option of a listbox (role=option): a choice inside the picker, a widget of its own' },
    'baseline-picker.tsx (none)': {
        count: 1,
        reason: "the baseline picker's ref form (比較): chooses what the views compare with, a view setting that fits none of the six kinds",
    },
    'catalog.tsx (none)': {
        count: 1,
        reason: "the catalog's element card: a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'explorer.tsx pane-title': {
        count: 1,
        reason: "the explorer's section head (▸ and its count): a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'inspector.tsx back-button': {
        count: 1,
        reason: "the inspector's back to the previous element (↶ and its name): a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for",
    },
    'inspector.tsx role=tab': { count: 1, reason: 'a tab of a tablist (role=tab): it switches what the pane shows, a widget of its own' },
    'knowledge/panel.tsx role=radio': {
        count: 1,
        reason: '新しい順 / 種類の順 of a knowledge list: segmented view settings (a radio group), not session actions',
    },
    'knowledge/panel.tsx knowledge-item-head': {
        count: 1,
        reason: "a knowledge item's head (kind, title) that opens it: a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'knowledge/panel.tsx knowledge-side': {
        count: 1,
        reason: "a side of a knowledge conflict (kind, title, labels) that opens it under the pair: a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the card's, not a button's",
    },
    'knowledge/panel.tsx knowledge-chip': {
        count: 4,
        reason: "a filter of the ナレッジ list (AS-IS, ルール, 発言…, 廃止も表示), on or off, an opened item's label as the same chip, which filters the list by it, and a reason chosen to retire an item (置き換わった…, on or off): a chip or badge of its own (a count, a reaction, a status pill): a view setting",
    },
    'knowledge/panel.tsx knowledge-link': {
        count: 1,
        reason: "another knowledge item named in running text (the item that replaced a retired one, a proposal's item and evidence), opening it in the list: a reference in running text that jumps to its source: its look is the text it stands for",
    },
    'lists.tsx problem': {
        count: 1,
        reason: "a problem of the problems list: a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'session/card.tsx role=menuitem': {
        count: 2,
        reason: "an item of a menu (role=menuitem): the menu's own row, named by what it does; the menu is opened by an open button",
    },
    'session/card.tsx decided-run': {
        count: 2,
        reason: 'the time of a decision, linking to its run: a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for',
    },
    'session/card.tsx run-quote-main': {
        count: 1,
        reason: "a run's quote of the message it applied: a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for",
    },
    'session/card.tsx (none)': {
        count: 1,
        reason: 'ChangeChip, an element a unit changed (＋ ✎ − #name): a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for',
    },
    'session/card.tsx decided-other': {
        count: 1,
        reason: 'the own words of an answer, opened in full: a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for',
    },
    'session/chat-head.tsx role=tab': { count: 1, reason: 'a tab of a tablist (role=tab): it switches what the pane shows, a widget of its own' },
    'session/chat.tsx chat-status': {
        count: 1,
        reason: "the chat head's AI status pill: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'session/chat.tsx chat-updated-pill-go': {
        count: 1,
        reason: "the floating 'updated above' pill that jumps to what changed: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'session/chat.tsx chat-latest': {
        count: 1,
        reason: '最新へ, the round ↓ with how many arrived: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'session/chat.tsx chat-turn-link': {
        count: 1,
        reason: 'the AI avatar and ↓ that jump to a turn: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'shared/reference.tsx chat-reply-ref': {
        count: 1,
        reason: "the quote of what a reply answers, and a knowledge item's source: a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for",
    },
    'search/entry.tsx app-bar-find': {
        count: 1,
        reason: "the app bar's 探す, shaped like a search field (🔍 探す and its key) that opens the palette: the view's chrome (the toolbar, the canvas controls, the app bar): labels collapse to icons by container queries; it changes nothing",
    },
    'session/chat.tsx role=menuitem': {
        count: 2,
        reason: "an item of a menu (role=menuitem): the menu's own row, named by what it does; the menu is opened by an open button",
    },
    'session/chat.tsx chat-unit-head': {
        count: 1,
        reason: "AI の作業's unit head (twisty, icon, title, state): a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'session/chat.tsx chat-launcher': {
        count: 1,
        reason: "the chat's round launcher with its badges: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button",
    },
    'session/chat.tsx chat-chip-remove': {
        count: 1,
        reason: 'the ✕ of a chip: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'session/chat.tsx chat-send': {
        count: 1,
        reason: "the composer's send arrow: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button",
    },
    'session/collab-menu.tsx collab-menu-button': {
        count: 1,
        reason: "the chat head's people button (avatars, count, ▾): a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'session/collab-menu.tsx role=menuitem': {
        count: 1,
        reason: "an item of a menu (role=menuitem): the menu's own row, named by what it does; the menu is opened by an open button",
    },
    'session/command-chip.tsx chat-command-chip': {
        count: 1,
        reason: "a command's chip in a message (icon, /id, name) that unfolds its description: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'session/composer-chips.tsx chat-chip-remove': {
        count: 1,
        reason: 'the ✕ of a target chip: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'session/composer-chips.tsx chat-chips-more': {
        count: 1,
        reason: "+n, the hidden target chips' count: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'session/composer-chips.tsx chat-chips-less': {
        count: 1,
        reason: 'the round ⌃ that folds the chips again: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'session/guide-card.tsx guide-goal-button': {
        count: 1,
        reason: "the map's heading, 🏁 ゴール: …, which opens the goal menu: the heading's own text in the goal's green (the approved preview keeps it)",
    },
    'session/guide-card.tsx guide-journey-button': {
        count: 1,
        reason: "the map's heading, 🧭 the journey's name, which opens the journeys panel: the heading's own text (the approved preview keeps it)",
    },
    'session/guide.tsx chat-guide': {
        count: 1,
        reason: "the composer's ガイド button, a wash with the compass that collapses to the icon on a narrow chat: the composer's tool, not a place's action",
    },
    'session/journey-detail.tsx journey-detail-row': {
        count: 1,
        reason: "a journey's row in the detail (name, where it stands, goal), opening the journeys panel: a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'session/journey-panel.tsx journey-chip': {
        count: 1,
        reason: "the app bar's journey chip (🧭 · 📍 → 🏁, a badge): a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail",
    },
    'session/mark-controls.tsx mark-count': {
        count: 1,
        reason: 'the count of votes, opening who voted: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail',
    },
    'session/mark-controls.tsx vote-heart': {
        count: 1,
        reason: 'the ♡ vote: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'session/mark-controls.tsx reaction': {
        count: 1,
        reason: 'a reaction with its count: a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail',
    },
    'session/mark-controls.tsx reaction-choice': {
        count: 2,
        reason: 'a reaction to pick in the reaction picker (an emoji): a chip or badge of its own (a count, a reaction, a status pill): it shows a state first and opens its detail',
    },
    'session/participants.tsx chat-people-offline': {
        count: 1,
        reason: "the participants list's オフライン n disclosure: a row or card whose whole box is the target (a list's row, a disclosure head): its layout is the row's, not a button's",
    },
    'session/selection-action.tsx add-to-request': {
        count: 1,
        reason: "the canvas selection's 💬: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button",
    },
    'session/status-slot.tsx chat-turn-link': {
        count: 1,
        reason: 'the AI avatar and ↓ that jump to a turn: icon-only, on a shape of its own (round, bordered or sized to its place): not a text button',
    },
    'session/status-slot.tsx chat-cancel-button': {
        count: 1,
        reason: "a run's bordered ✕ (asks first in a dialog of stop and danger Acts): icon-only, on a shape of its own (round, bordered or sized to its place): not a text button",
    },
    'settings-dialog.tsx active': {
        count: 4,
        reason: 'a segment or toggle of a view setting (active / aria-pressed): it changes how the view shows, not the files nor the session',
    },
    'states-canvas.tsx active': {
        count: 1,
        reason: 'a segment or toggle of a view setting (active / aria-pressed): it changes how the view shows, not the files nor the session',
    },
    'storming.tsx exception-layer-main': {
        count: 1,
        reason: "a toggle of a view setting (aria-pressed): the exceptions' layer over the canvas, included or not; it changes how the view shows, not the files nor the session",
    },
    'view/exception-lanes.tsx exception-lane-label': {
        count: 1,
        reason: "a lane's label over the canvas, pressed to emphasize its exception (aria-pressed): the view's chrome floating on the canvas, like a line's end; changes nothing",
    },
    'storming.tsx es-action': {
        count: 1,
        reason: "a storming element's action icon (its name as the tooltip): icon-only, on a shape of its own (round, bordered or sized to its place): not a text button",
    },
    'view/canvas-controls.tsx canvas-control': {
        count: 6,
        reason: "the view's chrome (the toolbar, the canvas controls, the app bar): labels collapse to icons by container queries; view settings, not session actions",
    },
    'shared/menu.tsx role=menuitem': {
        count: 1,
        reason: "an item of the shared action menu (role=menuitem: the stickies' 「…」 and right-click): the menu's own row, named by what it does, with its icon and key",
    },
    'view/export-menu.tsx role=menuitem': {
        count: 4,
        reason: "an item of a menu (role=menuitem): the menu's own row, named by what it does; the menu is opened by an open button",
    },
    'view/export-menu.tsx toolbar-button': {
        count: 1,
        reason: "the view's chrome (the toolbar, the canvas controls, the app bar): labels collapse to icons by container queries; view settings, not session actions",
    },
    'view/lines.tsx line-end-button': {
        count: 1,
        reason: 'an end of a pressed storming line (its colour box and label) that goes to its sticky: a reference in running text (a quote, a time, a chip of an element) that jumps to its source: its look is the text it stands for',
    },
    'view/lines.tsx offscreen-pointer': {
        count: 1,
        reason: "the pointer at the canvas's edge to stickies out of view (「→ n」): the view's chrome (the toolbar, the canvas controls, the app bar), floating on the canvas: moves the camera, changes nothing",
    },
    'view/toolbar.tsx toolbar-button': {
        count: 1,
        reason: "the view's chrome (the toolbar, the canvas controls, the app bar): labels collapse to icons by container queries; view settings, not session actions",
    },
    'view/toolbar.tsx menu-picker-button': {
        count: 1,
        reason: "the view's chrome (the toolbar, the canvas controls, the app bar): a picker's button that opens its list (a storming, a timeline, an exception); view settings, not session actions",
    },
    'view/toolbar.tsx role=option': { count: 1, reason: 'an option of a listbox (role=option): a choice inside the picker, a widget of its own' },
    'view/toolbar.tsx active': {
        count: 2,
        reason: 'a segment or toggle of a view setting (active / aria-pressed): it changes how the view shows, not the files nor the session',
    },
    'view/toolbar.tsx filter-clear': { count: 1, reason: "the filter menu's クリア in its head: resets a view setting, which fits none of the six kinds" },
};

describe('the text buttons are Acts (docs/ui-rules.md)', () => {
    test('every raw <button> is icon-only (icon-button) or listed with its reason', () => {
        const found = new Map<string, RawButton[]>();
        for (const b of buttons) {
            if (b.classes.includes('icon-button')) continue;
            const key = `${b.file} ${keyOf(b)}`;
            found.set(key, [...(found.get(key) ?? []), b]);
        }
        const unlisted = [...found].filter(([key]) => !(key in RAW_BUTTONS)).map(([key, bs]) => `${key} (line ${bs.map((b) => b.line).join(', ')})`);
        expect(unlisted).toEqual([]);
        const counts = Object.fromEntries([...found].map(([key, bs]) => [key, bs.length]));
        const listed = Object.fromEntries(Object.entries(RAW_BUTTONS).map(([key, { count }]) => [key, count]));
        // a new one of a listed kind fails too; one gone: lower its count (or drop the entry)
        expect(counts).toEqual(listed);
    });

    test('every exception says why', () => {
        for (const [key, { reason }] of Object.entries(RAW_BUTTONS)) expect(reason.length, key).toBeGreaterThan(20);
    });
});

/** The button classes `Act` replaced: their looks said nothing of what a press does. */
const OLD_CLASSES = [
    'chat-small',
    'primary',
    'ghost',
    'danger',
    'small',
    'guide-command',
    'guide-go',
    'guide-ask',
    'interview-choice',
    'cancel-dialog-button',
    'answer-other-button',
];

describe('the old button classes are gone', () => {
    test('no raw button carries one', () => {
        const old = buttons.filter((b) => b.classes.some((c) => OLD_CLASSES.includes(c))).map((b) => `${b.file}:${b.line} ${b.classes.join(' ')}`);
        expect(old).toEqual([]);
    });

    test('nor any component writes the ones that were buttons only (interview-choice stays on the checkboxes’ labels)', () => {
        const only = /(?<![\w-])(chat-small|guide-command|guide-go|guide-ask|cancel-dialog-button|answer-other-button)(?![\w-])/;
        expect(sources.filter(({ text }) => only.test(text)).map(({ file }) => file)).toEqual([]);
    });

    test('nor does styles.css style them', () => {
        const selectors = styles.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) ?? [];
        const old = selectors.filter((s) =>
            /button\.(primary|ghost|danger|small)\b|\.(chat-small|guide-command|guide-go|guide-ask|cancel-dialog-button|answer-other-button)(?![\w-])|\.interview-choice\.(send|other)\b/.test(
                s,
            ),
        );
        expect(old.map((s) => s.trim())).toEqual([]);
    });
});

/** The spacing properties the rhythm governs. */
const SPACING = /^(margin|padding)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(row-|column-)?gap$/;

/** A spacing value on the rhythm: a token, 0, auto, a hairline (1px, 2px), or calc() of tokens and plain numbers. */
const onRhythm = (v: string): boolean =>
    /^(0|auto|-?1px|-?2px|var\(--(space|gap)-[a-z0-9-]+\))$/.test(v) ||
    (v.startsWith('calc(') && v.replace(/var\(--(space|gap)-[a-z0-9-]+\)/g, '').replace(/[\s\d.*+/()-]|calc/g, '') === '');

/** The values of one declaration, split at the spaces outside parentheses (`4px var(--space-2)` is two). */
function values(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let current = '';
    for (const c of value.replace(/\s*!important$/, '').trim()) {
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (/\s/.test(c) && depth === 0) {
            if (current) out.push(current);
            current = '';
        } else current += c;
    }
    if (current) out.push(current);
    return out;
}

/** Every spacing value of styles.css off the rhythm, counted by value. */
function offRhythm(): Record<string, number> {
    const css = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    const counts: Record<string, number> = {};
    for (const m of css.matchAll(/(?<=[{;\s])([a-z-]+)\s*:\s*([^;{}]+);/g)) {
        if (!SPACING.test(m[1] ?? '')) continue;
        for (const v of values(m[2] ?? '')) if (!onRhythm(v)) counts[v] = (counts[v] ?? 0) + 1;
    }
    return counts;
}

/** Why a spacing value is off the rhythm, by group. */
const ON_SCALE = 'a step of the scale written in px, from before the tokens: replace it with its var(--space-*) or var(--gap-*) when the rule is touched';
const OFF_SCALE =
    "off the scale, from before the rhythm: the compact controls' and pills' insides (paddings of 3–7px, 10px, 14px); move each onto the scale when its rule is touched";
const BLEED = "a negative margin that pulls a part over its box's edge (an avatar ring, a row's hover, a bleed): sized to the part, not a gap";
const BY_TEXT = "sized to the text (em, ch) or the line (calc with the line height): a list's indent or a centring against a line, not a gap between groups";
const PAPER = "the print page's margins and gutters, in millimetres of paper";
const OWN_SIZE =
    "a layout's own size (the chat's edge, a thread's gap, a nesting depth, a dialog's top in the viewport): a custom property or calc() of one, set where it is defined";
const PLACED =
    "an inset that places a part by the size of another (a list's text aligned past its icon, the catalog's foot, a row's ♡ aligned with the cards' past their border): not a gap of the rhythm";

/**
 * The spacing values off the rhythm today, by value, with how many there are and why. Each new one fails; one moved
 * onto the tokens fails until its count is lowered here (the list only shrinks).
 */
const OFF_RHYTHM: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
    '4px': { count: 79, reason: ON_SCALE },
    '8px': { count: 58, reason: ON_SCALE },
    '12px': { count: 25, reason: ON_SCALE },
    '16px': { count: 9, reason: ON_SCALE },
    '24px': { count: 2, reason: ON_SCALE },
    '3px': { count: 20, reason: OFF_SCALE },
    '5px': { count: 14, reason: OFF_SCALE },
    '6px': { count: 91, reason: OFF_SCALE },
    '7px': { count: 5, reason: OFF_SCALE },
    '10px': { count: 24, reason: OFF_SCALE },
    '14px': { count: 14, reason: OFF_SCALE },
    '18px': { count: 1, reason: OFF_SCALE },
    '20px': { count: 3, reason: OFF_SCALE },
    '28px': { count: 1, reason: OFF_SCALE },
    '-1.5px': { count: 2, reason: BLEED },
    '-3px': { count: 1, reason: BLEED },
    '-4px': { count: 2, reason: BLEED },
    '-6px': { count: 1, reason: BLEED },
    '-8px': { count: 1, reason: BLEED },
    '-0.875rem': { count: 1, reason: BLEED },
    '-1.25rem': { count: 1, reason: BLEED },
    'calc(-4px * var(--s, 1))': { count: 1, reason: BLEED },
    '0.6ch': { count: 1, reason: BY_TEXT },
    '1.5ch': { count: 1, reason: BY_TEXT },
    '2ch': { count: 1, reason: BY_TEXT },
    '1.2em': { count: 2, reason: BY_TEXT },
    '1.4em': { count: 1, reason: BY_TEXT },
    '1.5em': { count: 2, reason: BY_TEXT },
    'calc((1.5em - 12px) / 2)': { count: 1, reason: BY_TEXT },
    'calc((1.5em - 13px) / 2)': { count: 3, reason: BY_TEXT },
    'calc((1em * var(--lh-body) - 14px) / 2)': { count: 1, reason: BY_TEXT },
    'calc((var(--chat-avatar) - 13px) / 2)': { count: 1, reason: BY_TEXT },
    '4mm': { count: 2, reason: PAPER },
    '10mm': { count: 1, reason: PAPER },
    'var(--chat-edge)': { count: 1, reason: OWN_SIZE },
    'var(--thread-gap)': { count: 1, reason: OWN_SIZE },
    'calc(0.5rem + (var(--depth, 0) + 1) * 0.875rem)': { count: 1, reason: OWN_SIZE },
    '10vh': { count: 1, reason: OWN_SIZE },
    '40px': { count: 1, reason: PLACED },
    'calc(var(--space-3) + 1px)': { count: 1, reason: PLACED },
    'calc(var(--space-4) + 16px + var(--space-2))': { count: 2, reason: PLACED },
};

describe('the spacing is on the tokens (docs/ui-rules.md)', () => {
    test('margin, padding and gap in styles.css are tokens, 0, auto, 1px, 2px or calc() of tokens, else listed', () => {
        const listed = Object.fromEntries(Object.entries(OFF_RHYTHM).map(([value, { count }]) => [value, count]));
        expect(offRhythm()).toEqual(listed);
    });

    test('every exception says why', () => {
        for (const [value, { reason }] of Object.entries(OFF_RHYTHM)) expect(reason.length, value).toBeGreaterThan(20);
    });

    test('the rhythm tokens: inside a group 8px, between groups twice that, a change of turn 24px', () => {
        const root = styles.slice(styles.indexOf(':root {'), styles.indexOf('\n}', styles.indexOf(':root {')));
        expect(root).toContain('--gap-inside: var(--space-2);');
        expect(root).toContain('--gap-between: var(--space-4);');
        expect(root).toContain('--gap-turn: var(--space-5);');
        expect(root).toContain('--space-2: 8px;');
        expect(root).toContain('--space-4: 16px;');
        expect(root).toContain('--space-5: 24px;');
    });
});
