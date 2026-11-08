// The Markdown the page shows: the AI's answers in the chat (ADR 0030) and the knowledge's items (ADR 0031, section 2),
// in the Live View and on the Worker's page. Paragraphs (their line breaks kept), bullet and numbered lists (one level
// of nesting; deeper items are flattened to that level), headings (any number of `#`, all one level: the columns are
// too narrow to tell several apart; a knowledge item's are drawn as paragraphs, its title being its heading), fenced
// code blocks, GFM tables, inline code, **bold** and *italic*. An image of
// the page's own (`![label](image:<id>)`, an attached image) is an image, drawn where the page can resolve its id
// (`markdown-text.tsx`); other links and images are text (`label (url)`), never followed nor loaded; HTML is text, never
// markup. Whatever is not understood stays as written. The texts are short and the columns narrow, so a small parser
// here rather than a library. Pure: no React (`markdown-text.tsx` renders it).

/** A run of inline content. */
export type Inline =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'strong'; readonly children: readonly Inline[] }
    | { readonly kind: 'em'; readonly children: readonly Inline[] }
    /** An attached image (`![alt](image:<id>)`); `url` as written, for the text it shows where it cannot be drawn. */
    | { readonly kind: 'image'; readonly id: string; readonly alt: string; readonly url: string };

/** An item of a list: its text and, at the top level only, the list nested in it. */
export interface ListItem {
    readonly content: readonly Inline[];
    readonly children?: MdList;
}

export interface MdList {
    readonly kind: 'list';
    readonly ordered: boolean;
    /** The number of its first item (a numbered list cut by a code block goes on from where it was). */
    readonly start: number;
    readonly items: readonly ListItem[];
}

export type Align = 'left' | 'center' | 'right' | undefined;

export type Block =
    | { readonly kind: 'heading'; readonly content: readonly Inline[] }
    | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
    | { readonly kind: 'code'; readonly text: string }
    | {
          readonly kind: 'table';
          readonly align: readonly Align[];
          readonly head: readonly (readonly Inline[])[];
          readonly rows: readonly (readonly (readonly Inline[])[])[];
      }
    | MdList;

const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^`]*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const DELIMITER_CELL = /^:?-+:?$/;

const isBlank = (line: string): boolean => line.trim() === '';

/** How far a line is indented, a tab as four spaces. */
function indentOf(line: string): number {
    let n = 0;
    for (const c of line) {
        if (c === ' ') n++;
        else if (c === '\t') n += 4;
        else break;
    }
    return n;
}

/** The line without up to `n` columns of its indentation. */
function dedent(line: string, n: number): string {
    let i = 0;
    let col = 0;
    while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) {
        col += line[i] === '\t' ? 4 : 1;
        i++;
    }
    return line.slice(i);
}

/** A table row's cells: split on `|` (not `\|`, not inside `code`), the outer pipes dropped, each trimmed. */
export function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells: string[] = [];
    let cell = '';
    let ticks = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && s[i + 1] === '|') {
            cell += ticks > 0 ? '\\|' : '|';
            i++;
        } else if (c === '`') {
            let run = 0;
            while (s[i + run] === '`') run++;
            cell += '`'.repeat(run);
            i += run - 1;
            ticks = ticks === 0 ? run : ticks === run ? 0 : ticks;
        } else if (c === '|' && ticks === 0) {
            cells.push(cell.trim());
            cell = '';
        } else cell += c;
    }
    cells.push(cell.trim());
    return cells;
}

/** The alignments of a table's delimiter row, or undefined when the line is not one. */
function delimiterRow(line: string): Align[] | undefined {
    if (!line.includes('-')) return undefined;
    const cells = splitRow(line);
    if (!cells.every((c) => DELIMITER_CELL.test(c))) return undefined;
    // a row of dashes without a pipe is a rule (or a setext heading's underline), not a table's
    if (cells.length === 1 && !line.includes('|')) return undefined;
    return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
}

/** Whether a table starts at line `i`: a row with pipes, then a delimiter row of as many cells. */
function tableAt(lines: readonly string[], i: number): Align[] | undefined {
    const line = lines[i];
    const next = lines[i + 1];
    if (line === undefined || next === undefined || !line.includes('|')) return undefined;
    const align = delimiterRow(next);
    return align && align.length === splitRow(line).length ? align : undefined;
}

/** Whether line `i` starts a block other than a paragraph (so it ends the paragraph before it). */
function startsBlock(lines: readonly string[], i: number): boolean {
    const line = lines[i] ?? '';
    return HEADING.test(line) || FENCE.test(line) || ITEM.test(line) || tableAt(lines, i) !== undefined;
}

/** The URL of an attached image: `image:` and its id. */
const IMAGE_URL = /^image:([A-Za-z0-9_-]+)$/;

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?[\\\]^_`{|}~]/;

/**
 * Inline content: `code`, **bold**, *italic*, links and images as text, backslash escapes. `\@` is left as written:
 * it is the element references' escape (`references.ts`), read after this.
 */
export function parseInline(src: string): Inline[] {
    const out: Inline[] = [];
    let text = '';
    const flush = (): void => {
        if (text) out.push({ kind: 'text', text });
        text = '';
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const rest = src.slice(i);
        if (c === '\\' && i + 1 < src.length && PUNCTUATION.test(src[i + 1])) {
            text += src[i + 1];
            i += 2;
            continue;
        }
        if (c === '`') {
            let run = 0;
            while (src[i + run] === '`') run++;
            const fence = '`'.repeat(run);
            // the closing run: as long as the opening one, not part of a longer run
            let close = src.indexOf(fence, i + run);
            while (close !== -1 && (src[close + run] === '`' || src[close - 1] === '`')) {
                let skip = close;
                while (src[skip] === '`') skip++;
                close = src.indexOf(fence, skip);
            }
            if (close === -1) {
                text += fence;
                i += run;
                continue;
            }
            let code = src.slice(i + run, close).replace(/\n/g, ' ');
            if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
            flush();
            out.push({ kind: 'code', text: code });
            i = close + run;
            continue;
        }
        if (c === '[' || (c === '!' && src[i + 1] === '[')) {
            const link = /^!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"\n]*")?\s*\)/.exec(rest);
            if (link) {
                const [whole, label = '', url = ''] = link;
                const image = c === '!' ? IMAGE_URL.exec(url) : null;
                if (image) {
                    flush();
                    out.push({ kind: 'image', id: image[1] ?? '', alt: inlineText(parseInline(label)), url });
                    i += whole.length;
                    continue;
                }
                for (const n of parseInline(label)) {
                    if (n.kind === 'text') text += n.text;
                    else {
                        flush();
                        out.push(n);
                    }
                }
                text += label === url || url === '' ? '' : label === '' ? url : ` (${url})`;
                i += whole.length;
                continue;
            }
        }
        if (c === '<') {
            const auto = /^<((?:https?|mailto):[^\s<>]+)>/.exec(rest);
            if (auto) {
                text += auto[1];
                i += auto[0].length;
                continue;
            }
        }
        if (c === '*' && src[i + 1] === '*') {
            let close = src.indexOf('**', i + 2);
            // `***` closes an italic inside, then the bold
            while (close !== -1 && src[close + 2] === '*') close++;
            if (close > i + 2 && !/\s/.test(src[i + 2]) && !/\s/.test(src[close - 1])) {
                flush();
                out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, close)) });
                i = close + 2;
                continue;
            }
            text += '**';
            i += 2;
            continue;
        }
        if (c === '*') {
            const close = findEmClose(src, i + 1);
            if (close !== -1 && !/\s/.test(src[i + 1] ?? ' ')) {
                flush();
                out.push({ kind: 'em', children: parseInline(src.slice(i + 1, close)) });
                i = close + 1;
                continue;
            }
        }
        text += c;
        i++;
    }
    flush();
    return out;
}

/** Inline content as text: its marks dropped, its images left out. */
function inlineText(content: readonly Inline[]): string {
    return content.map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : n.kind === 'image' ? '' : inlineText(n.children))).join('');
}

/** The `*` closing an italic opened before `from`: a single one (not `**`), after a character that is not a space. */
function findEmClose(src: string, from: number): number {
    for (let j = from + 1; j < src.length; j++) {
        if (src[j] === '\\') {
            j++;
            continue;
        }
        if (src[j] !== '*') continue;
        if (src[j + 1] === '*') {
            j++;
            continue;
        }
        if (!/\s/.test(src[j - 1])) return j;
    }
    return -1;
}

/** A list from line `start` (its first item, `first`): its items and those nested in them, and the line after it. */
function parseList(lines: readonly string[], start: number, first: RegExpExecArray): { list: MdList; next: number } {
    const base = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const items: { lines: string[]; children?: { ordered: boolean; start: number; items: string[][] } }[] = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
            // a blank line goes on with the list only when an item or an indented line comes next
            let j = i + 1;
            while (j < lines.length && isBlank(lines[j])) j++;
            const after = lines[j];
            if (after === undefined || (!ITEM.test(after) && indentOf(after) <= base) || FENCE.test(after)) break;
            i = j;
            continue;
        }
        // a code block ends the list (a numbered list after it goes on with its numbers)
        if (FENCE.test(line)) break;
        const m = ITEM.exec(line);
        const indent = indentOf(line);
        const last = items[items.length - 1];
        if (m && indent < base + 2) {
            if (/\d/.test(m[2]) !== ordered) break;
            items.push({ lines: [m[3]] });
        } else if (m && last) {
            // nested at any depth: one level
            const children = (last.children ??= { ordered: /\d/.test(m[2]), start: Number.parseInt(m[2], 10) || 1, items: [] });
            children.items.push([m[3]]);
        } else if (last && (indent > base || !startsBlock(lines, i))) {
            // a line going on with the item before (nested or not)
            const child = last.children?.items[last.children.items.length - 1];
            (child ?? last.lines).push(line.trim());
        } else break;
        i++;
    }
    return {
        list: {
            kind: 'list',
            ordered,
            start: Number.parseInt(first[2], 10) || 1,
            items: items.map((it) => ({
                content: parseInline(it.lines.join('\n')),
                ...(it.children && {
                    children: {
                        kind: 'list',
                        ordered: it.children.ordered,
                        start: it.children.start,
                        items: it.children.items.map((c) => ({ content: parseInline(c.join('\n')) })),
                    },
                }),
            })),
        },
        next: i,
    };
}

/** The answer's text as blocks. */
export function parseMarkdown(src: string): Block[] {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const blocks: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
            i++;
            continue;
        }
        const fence = FENCE.exec(line);
        if (fence) {
            const indent = indentOf(fence[1]);
            const mark = fence[2];
            const body: string[] = [];
            i++;
            while (i < lines.length) {
                const close = lines[i].trim();
                if (close.length >= mark.length && close[0] === mark[0] && new RegExp(`^\\${mark[0]}+$`).test(close)) {
                    i++;
                    break;
                }
                body.push(dedent(lines[i], indent));
                i++;
            }
            blocks.push({ kind: 'code', text: body.join('\n') });
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            blocks.push({ kind: 'heading', content: parseInline(heading[1]) });
            i++;
            continue;
        }
        const align = tableAt(lines, i);
        if (align) {
            const width = align.length;
            // ragged rows: missing cells empty, extra cells dropped
            const cells = (row: string): Inline[][] => {
                const got = splitRow(row);
                return Array.from({ length: width }, (_, k) => parseInline(got[k] ?? ''));
            };
            const head = cells(line);
            const rows: Inline[][][] = [];
            i += 2;
            while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !HEADING.test(lines[i]) && !FENCE.test(lines[i])) {
                rows.push(cells(lines[i]));
                i++;
            }
            blocks.push({ kind: 'table', align, head, rows });
            continue;
        }
        const item = ITEM.exec(line);
        if (item) {
            const { list, next } = parseList(lines, i, item);
            blocks.push(list);
            i = next;
            continue;
        }
        const para: string[] = [line.trim()];
        i++;
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
            para.push(lines[i].trim());
            i++;
        }
        blocks.push({ kind: 'paragraph', content: parseInline(para.join('\n')) });
    }
    return blocks;
}

/**
 * The text without its Markdown marks, for a line that shows it plain (a closed item of the knowledge, clamped): a line
 * per paragraph, heading, list item and table row (its cells a space apart), a code block as written, images left out.
 * Element references (`@{…}`) stay as written, for the page to name them.
 */
export function markdownPlain(src: string): string {
    const items = (list: MdList): string[] => list.items.flatMap((it) => [inlineText(it.content), ...(it.children ? items(it.children) : [])]);
    const lines = parseMarkdown(src).flatMap((b): string[] => {
        switch (b.kind) {
            case 'heading':
            case 'paragraph':
                return [inlineText(b.content)];
            case 'code':
                return [b.text];
            case 'list':
                return items(b);
            case 'table':
                return [b.head, ...b.rows].map((row) =>
                    row
                        .map(inlineText)
                        .filter((c) => c !== '')
                        .join(' '),
                );
        }
    });
    return lines
        .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
        .filter((l) => l !== '')
        .join('\n');
}
