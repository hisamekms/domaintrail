// The file of one knowledge item, as the `files` store keeps it in the workspace's `knowledge/` (ADR 0031, section 5):
// Markdown with a front matter. The front matter holds what is not the text — the ID, the version, the title, the labels, the
// stickies it is about, the items it conflicts with, the session that made it, the times and the sources with their
// quotes — and the body is the text, images referred to as `image:img_…` (the files beside it in `knowledge/images/`).
//
//     ---
//     id: kn_7c0f3a9d2e
//     version: 1
//     title: "月末締めの案件は翌月の作業になる"
//     when: as_is
//     kind: rule
//     origin: agreed
//     perspective: "案件担当"
//     about:
//       - Ordering.CreateSpecification
//     conflictsWith: []
//     createdIn: s_20261105
//     createdAt: 2026-11-05T09:00:00.000Z
//     updatedAt: 2026-11-05T09:05:00.000Z
//     sources:
//       - session: s_20261105
//         message: m_12
//         at: 2026-11-05T09:00:00.000Z
//         quote: "月末締めの案件は翌月の作業にずれる"
//     ---
//
//     月末締めの案件は、作業が翌月にずれることがある。
//
// The front matter is YAML, of a small subset that is read here without a YAML library: `key: value` at the top,
// lists of scalars (`- x` lines, or `[a, b]`) and lists of flat maps (the sources); scalars plain, `"…"` (JSON's
// escapes) or `'…'`; `#` comments. dt writes it that way, in a fixed key order, so that a diff in git shows what
// changed; a person may edit it by hand, and what does not read is reported by `dt check` (K001) and skipped by the
// store, never written over. An item has a title (ADR 0031, section 2): a file without one does not read (K001), as
// those written before titles were.
//
// Pure: reading and printing text. The store (`infrastructure/files.ts`) does the I/O; `dt check` reads the same.
import { Knowledge, type Result } from '../generated/index.js';

/** The directory of the items in a workspace (`files` store), relative to its root. */
export const KNOWLEDGE_DIR = 'knowledge';

/** The directory of the images, inside `KNOWLEDGE_DIR`. */
export const IMAGES_DIR = 'images';

/** The name of an item's file: `<id>.md`. Only the `.md` files named so are items; others (a README) are left alone. */
export const itemFileName = (id: Knowledge.KnowledgeItemId): string => `${id}.md`;

/** The ID an item's file name gives, when the name is one of an item (`kn_….md`). */
export function idOfFileName(name: string): string | undefined {
    return /^(kn_[^/\\]*)\.md$/.exec(name)?.[1];
}

/** A problem of a file that does not read, at a line of it (1-based). */
export interface FileProblem {
    readonly line: number;
    readonly message: string;
}

/** An item read from its file, with the line of each of its `about` entries (where `dt check` reports one missing). */
export interface ItemFile {
    readonly item: Knowledge.KnowledgeItem;
    readonly aboutLines: readonly number[];
}

// ---- the front matter's YAML subset ----

interface Scalar {
    readonly kind: 'scalar';
    /** `undefined` for a null (`key:` with nothing, `null`, `~`). */
    readonly value: string | undefined;
    readonly line: number;
}

interface List {
    readonly kind: 'list';
    readonly items: readonly Node[];
    readonly line: number;
}

interface MapNode {
    readonly kind: 'map';
    readonly entries: ReadonlyMap<string, { readonly node: Node; readonly line: number }>;
    readonly line: number;
}

type Node = Scalar | List | MapNode;

interface Line {
    text: string;
    readonly line: number;
}

class Unreadable extends Error {
    constructor(
        readonly line: number,
        message: string,
    ) {
        super(message);
    }
}

const isContent = (l: Line): boolean => l.text.trim() !== '' && !l.text.trimStart().startsWith('#');
const indentOf = (text: string): number => text.length - text.trimStart().length;
const KEY = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/;

function nextContent(lines: readonly Line[], i: number): number {
    while (i < lines.length && !isContent(lines[i])) i++;
    return i;
}

/** The value after `key:` or `- `: a scalar or a flow list of scalars. */
function inlineValue(text: string, line: number): Node {
    const s = text.trim();
    if (s.startsWith('[')) {
        const items: Node[] = [];
        let rest = s.slice(1).trimStart();
        if (rest.startsWith(']')) return endOf(rest.slice(1), line, { kind: 'list', items, line });
        for (;;) {
            const [value, after] = scalarPrefix(rest, line, /[,\]]/);
            items.push({ kind: 'scalar', value, line });
            const next = after.trimStart();
            if (next.startsWith(',')) rest = next.slice(1).trimStart();
            else if (next.startsWith(']')) return endOf(next.slice(1), line, { kind: 'list', items, line });
            else throw new Unreadable(line, 'A list written [a, b] ends with "]".');
        }
    }
    if (s.startsWith('{')) throw new Unreadable(line, 'Maps written {…} are not read here; write one key per line.');
    const [value, after] = scalarPrefix(s, line);
    return endOf(after, line, { kind: 'scalar', value, line });
}

/** What follows a value: nothing, or a comment. */
function endOf(after: string, line: number, node: Node): Node {
    const rest = after.trim();
    if (rest !== '' && !rest.startsWith('#')) throw new Unreadable(line, `Unexpected text after the value: ${rest}`);
    return node;
}

/** A scalar at the start of `s` and what follows it; a plain one ends at `stop` (in a flow list) or a comment. */
function scalarPrefix(s: string, line: number, stop?: RegExp): [string | undefined, string] {
    if (s.startsWith('"')) {
        for (let i = 1; i < s.length; i++) {
            if (s[i] === '\\') i++;
            else if (s[i] === '"') {
                let value: unknown;
                try {
                    value = JSON.parse(s.slice(0, i + 1));
                } catch {
                    throw new Unreadable(line, `A "…" string has an escape that is not JSON's: ${s.slice(0, i + 1)}`);
                }
                if (typeof value !== 'string') throw new Unreadable(line, 'A "…" string is not closed.');
                return [value, s.slice(i + 1)];
            }
        }
        throw new Unreadable(line, 'A "…" string is not closed.');
    }
    if (s.startsWith("'")) {
        for (let i = 1; i < s.length; i++) {
            if (s[i] !== "'") continue;
            if (s[i + 1] === "'") i++;
            else return [s.slice(1, i).replaceAll("''", "'"), s.slice(i + 1)];
        }
        throw new Unreadable(line, "A '…' string is not closed.");
    }
    let end = s.length;
    const comment = /(^|[ \t])#/.exec(s);
    if (comment) end = comment.index;
    if (stop) {
        const at = stop.exec(s);
        if (at && at.index < end) end = at.index;
    }
    const plain = s.slice(0, end).trim();
    return [plain === '' || plain === '~' || plain === 'null' ? undefined : plain, s.slice(end)];
}

/** A block map whose keys are at `indent`, from line `i`; returns it and the line after it. */
function blockMap(lines: Line[], i: number, indent: number): [MapNode, number] {
    const entries = new Map<string, { node: Node; line: number }>();
    const first = lines[i]?.line ?? 0;
    for (i = nextContent(lines, i); i < lines.length; i = nextContent(lines, i)) {
        const l = lines[i];
        const ind = indentOf(l.text);
        if (ind < indent) break;
        if (ind > indent) throw new Unreadable(l.line, 'Unexpected indentation.');
        const m = KEY.exec(l.text.slice(ind).trimEnd());
        if (!m) {
            // a list at the indentation of the key it belongs to ends the map it is in
            if (l.text.slice(ind).startsWith('-')) break;
            throw new Unreadable(l.line, 'Expected `key: value`.');
        }
        const key = m[1];
        if (entries.has(key)) throw new Unreadable(l.line, `The key '${key}' is written twice.`);
        const value = m[2];
        if (value !== undefined && value.trim() !== '' && !value.trim().startsWith('#')) {
            entries.set(key, { node: inlineValue(value, l.line), line: l.line });
            i++;
            continue;
        }
        const j = nextContent(lines, i + 1);
        const below = lines[j];
        const belowIndent = below === undefined ? -1 : indentOf(below.text);
        const isItem = below !== undefined && below.text.slice(belowIndent).startsWith('-');
        if (below !== undefined && (belowIndent > ind || (belowIndent === ind && isItem))) {
            const [node, after] = isItem ? blockList(lines, j, belowIndent) : blockMap(lines, j, belowIndent);
            entries.set(key, { node, line: l.line });
            i = after;
        } else {
            entries.set(key, { node: { kind: 'scalar', value: undefined, line: l.line }, line: l.line });
            i++;
        }
    }
    return [{ kind: 'map', entries, line: first }, i];
}

/** A block list whose `-` are at `indent`, from line `i`; returns it and the line after it. */
function blockList(lines: Line[], i: number, indent: number): [List, number] {
    const items: Node[] = [];
    const first = lines[i].line;
    for (i = nextContent(lines, i); i < lines.length; i = nextContent(lines, i)) {
        const l = lines[i];
        const ind = indentOf(l.text);
        if (ind < indent) break;
        if (ind > indent) throw new Unreadable(l.line, 'Unexpected indentation.');
        const text = l.text.slice(ind).trimEnd();
        if (!text.startsWith('-')) break;
        const rest = text.slice(1);
        if (rest.trim() === '') throw new Unreadable(l.line, 'Write a list item on the line of its "-".');
        if (!/^[ \t]/.test(rest)) throw new Unreadable(l.line, 'Expected a space after "-".');
        const content = rest.trimStart();
        if (KEY.test(content) && !content.startsWith('"') && !content.startsWith("'")) {
            // `- key: value` opens a map whose keys are where `key` is
            const itemIndent = ind + 1 + (rest.length - content.length);
            l.text = ' '.repeat(itemIndent) + content;
            const [node, after] = blockMap(lines, i, itemIndent);
            items.push(node);
            i = after;
        } else {
            items.push(inlineValue(content, l.line));
            i++;
        }
    }
    return [{ kind: 'list', items, line: first }, i];
}

// ---- from the front matter to an item ----

/** The fields of the front matter, in the order dt writes them. */
const KEYS = [
    'id',
    'version',
    'title',
    'when',
    'kind',
    'origin',
    'perspective',
    'about',
    'conflictsWith',
    'createdIn',
    'createdAt',
    'updatedAt',
    'sources',
    'state',
    'deletedBy',
    'deletedAt',
] as const;
const SOURCE_KEYS = ['session', 'message', 'at', 'quote'] as const;
const WHEN: readonly Knowledge.When[] = ['as_is', 'to_be', 'none'];
const KINDS: readonly Knowledge.KnowledgeKind[] = ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'];
const ORIGINS: readonly Knowledge.Origin[] = ['said', 'agreed', 'investigated', 'inferred'];

/** Reads the fields of a map, each checked; the first problem is thrown. */
class Fields {
    constructor(
        private readonly map: MapNode,
        private readonly where: string,
    ) {}

    line(key: string): number {
        return this.map.entries.get(key)?.line ?? this.map.line;
    }

    private name(key: string): string {
        return this.where ? `${this.where}.${key}` : key;
    }

    optional(key: string): string | undefined {
        const entry = this.map.entries.get(key);
        if (entry === undefined) return undefined;
        if (entry.node.kind !== 'scalar') throw new Unreadable(entry.line, `'${this.name(key)}' is one value, not a list or a map.`);
        return entry.node.value;
    }

    required(key: string): string {
        const value = this.optional(key);
        if (value === undefined) throw new Unreadable(this.line(key), `'${this.name(key)}' is missing.`);
        return value;
    }

    /** A list (absent or null: empty), each entry with its line. */
    list(key: string): readonly Node[] {
        const entry = this.map.entries.get(key);
        if (entry === undefined || (entry.node.kind === 'scalar' && entry.node.value === undefined)) return [];
        if (entry.node.kind !== 'list') throw new Unreadable(entry.line, `'${this.name(key)}' is a list.`);
        return entry.node.items;
    }

    made<T, E extends { readonly invariant: string }>(key: string, make: (v: string) => Result<T, E>, value = this.required(key)): T {
        const r = make(value);
        if (!r.ok) throw new Unreadable(this.line(key), `'${this.name(key)}' is not valid (${r.error.invariant}): ${value}`);
        return r.value;
    }

    oneOf<T extends string>(key: string, values: readonly T[]): T {
        const value = this.required(key);
        const found = values.find((v) => v === value);
        if (found === undefined) throw new Unreadable(this.line(key), `'${this.name(key)}' is one of ${values.join(', ')}: not ${value}.`);
        return found;
    }

    time(key: string): Date {
        const value = this.required(key);
        const date = new Date(value);
        if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(date.getTime()))
            throw new Unreadable(this.line(key), `'${this.name(key)}' is a time like 2026-11-05T09:00:00.000Z: not ${value}.`);
        return date;
    }

    unknown(known: readonly string[]): void {
        for (const [key, { line }] of this.map.entries)
            if (!known.includes(key)) throw new Unreadable(line, `Unknown key '${this.name(key)}' (known: ${known.join(', ')}).`);
    }
}

function scalarOf(node: Node, what: string): { value: string; line: number } {
    if (node.kind !== 'scalar' || node.value === undefined) throw new Unreadable(node.line, `Each entry of '${what}' is one value.`);
    return { value: node.value, line: node.line };
}

function made<T, E extends { readonly invariant: string }>(
    make: (v: string) => Result<T, E>,
    { value, line }: { value: string; line: number },
    what: string,
): T {
    const r = make(value);
    if (!r.ok) throw new Unreadable(line, `An entry of '${what}' is not valid (${r.error.invariant}): ${value}`);
    return r.value;
}

function sourceOf(node: Node, index: number): Knowledge.Source {
    if (node.kind !== 'map') throw new Unreadable(node.line, `'sources' lists maps of ${SOURCE_KEYS.join(', ')}.`);
    const f = new Fields(node, `sources[${index}]`);
    f.unknown(SOURCE_KEYS);
    return {
        session: f.made('session', Knowledge.makeSessionRef),
        message: f.made('message', Knowledge.makeMessageRef),
        at: f.time('at'),
        quote: f.made('quote', Knowledge.makeQuote),
    };
}

function itemOf(front: MapNode, text: string, bodyLine: number, fileId: string | undefined): ItemFile {
    const f = new Fields(front, '');
    f.unknown(KEYS);
    const id = f.made('id', Knowledge.makeKnowledgeItemId);
    if (fileId !== undefined && fileId !== id) throw new Unreadable(f.line('id'), `The file of item '${id}' is named ${fileId}.md: name it ${id}.md.`);
    const versionText = f.required('version');
    const versionNumber = /^\d+$/.test(versionText) ? Number(versionText) : Number.NaN;
    const version = Knowledge.makeItemVersion(versionNumber);
    if (!version.ok) throw new Unreadable(f.line('version'), `'version' is a whole number from 1: not ${versionText}.`);
    const titleText = f.required('title');
    const titleMade = Knowledge.makeItemTitle(titleText);
    if (!titleMade.ok)
        throw new Unreadable(f.line('title'), `'title' is one line of at most 40 characters, without spaces at its ends: not ${JSON.stringify(titleText)}.`);
    const title = titleMade.value;
    const perspective = f.optional('perspective');
    const labels: Knowledge.Labels = {
        when: f.oneOf('when', WHEN),
        kind: f.oneOf('kind', KINDS),
        origin: f.oneOf('origin', ORIGINS),
        ...(perspective !== undefined && { perspective: f.made('perspective', Knowledge.makePerspective, perspective) }),
    };
    const aboutNodes = f.list('about').map((n) => scalarOf(n, 'about'));
    const about = aboutNodes.map((n) => made(Knowledge.makeStickyRef, n, 'about'));
    const itemText = Knowledge.makeItemText(text);
    if (!itemText.ok) throw new Unreadable(bodyLine, `The text (below the front matter) is ${text === '' ? 'empty' : 'too long (at most 20000 characters)'}.`);
    const content: Knowledge.ItemContent = { title, text: itemText.value, labels, about };
    if (Knowledge.checkItemContent(content).length > 0) throw new Unreadable(f.line('about'), "'about' names a sticky twice.");
    const conflictsWith = f.list('conflictsWith').map((n) => made(Knowledge.makeKnowledgeItemId, scalarOf(n, 'conflictsWith'), 'conflictsWith'));
    const createdIn = f.optional('createdIn');
    const common: Knowledge.KnowledgeItemCommon = {
        id,
        content,
        sources: f.list('sources').map(sourceOf),
        version: version.value,
        conflictsWith,
        ...(createdIn !== undefined && { createdIn: f.made('createdIn', Knowledge.makeSessionRef, createdIn) }),
        createdAt: f.time('createdAt'),
        updatedAt: f.time('updatedAt'),
    };
    const state = f.optional('state') ?? 'live';
    let item: Knowledge.KnowledgeItem;
    if (state === 'live') {
        for (const key of ['deletedBy', 'deletedAt'])
            if (f.optional(key) !== undefined) throw new Unreadable(f.line(key), `'${key}' is only for a deleted item.`);
        item = { ...common, state: 'Live' };
    } else if (state === 'deleted')
        item = { ...common, state: 'Deleted', deletedBy: f.made('deletedBy', Knowledge.makeUserName), deletedAt: f.time('deletedAt') };
    else throw new Unreadable(f.line('state'), `'state' is live or deleted: not ${state}.`);
    const violated = Knowledge.checkKnowledgeItem(item);
    if (violated.length > 0) {
        const where: Record<string, string> = {
            distinctSources: 'sources',
            distinctConflicts: 'conflictsWith',
            notConflictingItself: 'conflictsWith',
            conflictsSourced: 'conflictsWith',
        };
        const messages: Record<string, string> = {
            distinctSources: "'sources' names a message twice.",
            distinctConflicts: "'conflictsWith' names an item twice.",
            notConflictingItself: "'conflictsWith' names the item itself.",
            conflictsSourced: 'An item in a conflict has a source.',
        };
        throw new Unreadable(f.line(where[violated[0]]), messages[violated[0]]);
    }
    return { item, aboutLines: aboutNodes.map((n) => n.line) };
}

/**
 * Reads an item's file. `fileName`, when given, must be `<id>.md` of the ID it holds. A file that does not read gives
 * its first problem, at its line.
 */
export function readItemFile(text: string, fileName?: string): Result<ItemFile, FileProblem> {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    try {
        if (lines[0]?.trimEnd() !== '---') throw new Unreadable(1, 'An item file starts with a front matter: a line "---", the fields, and a line "---".');
        const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
        if (close < 0) throw new Unreadable(lines.length, 'The front matter is not closed by a line "---".');
        const front: Line[] = lines.slice(1, close).map((t, i) => ({ text: t.replaceAll('\t', '  '), line: i + 2 }));
        const start = nextContent(front, 0);
        if (start < front.length && indentOf(front[start].text) !== 0) throw new Unreadable(front[start].line, 'Unexpected indentation.');
        const [map, end] = blockMap(front, start, 0);
        if (end < front.length) throw new Unreadable(front[end].line, 'Expected `key: value`.');
        // the body: after one blank line, and without the one line break that ends the file
        let bodyLines = lines.slice(close + 1);
        let bodyLine = close + 2;
        if (bodyLines.length > 1 && bodyLines[0] === '') {
            bodyLines = bodyLines.slice(1);
            bodyLine++;
        }
        let body = bodyLines.join('\n');
        if (body.endsWith('\n')) body = body.slice(0, -1);
        const fileId = fileName === undefined ? undefined : (idOfFileName(fileName) ?? fileName.replace(/\.md$/, ''));
        return { ok: true, value: itemOf(map, body, bodyLine, fileId) };
    } catch (e) {
        if (e instanceof Unreadable) return { ok: false, error: { line: e.line, message: e.message } };
        throw e;
    }
}

// ---- from an item to its file ----

const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

/** A string as a scalar: plain when it cannot read as anything else, otherwise quoted with JSON's escapes. */
function scalar(value: string): string {
    return /^[A-Za-z_][A-Za-z0-9_.@+\-/]*$/.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value);
}

const time = (d: Date): string => d.toISOString();

/** The file of an item: its front matter, a blank line, its text and one line break. */
export function printItemFile(item: Knowledge.KnowledgeItem): string {
    const out = ['---'];
    const { title, labels, about, text } = item.content;
    out.push(
        `id: ${item.id}`,
        `version: ${item.version}`,
        `title: ${scalar(title)}`,
        `when: ${labels.when}`,
        `kind: ${labels.kind}`,
        `origin: ${labels.origin}`,
    );
    if (labels.perspective !== undefined) out.push(`perspective: ${scalar(labels.perspective)}`);
    const list = (key: string, values: readonly string[]): void => {
        if (values.length === 0) out.push(`${key}: []`);
        else out.push(`${key}:`, ...values.map((v) => `  - ${scalar(v)}`));
    };
    list('about', about);
    list('conflictsWith', item.conflictsWith);
    if (item.createdIn !== undefined) out.push(`createdIn: ${scalar(item.createdIn)}`);
    out.push(`createdAt: ${time(item.createdAt)}`, `updatedAt: ${time(item.updatedAt)}`);
    if (item.sources.length === 0) out.push('sources: []');
    else {
        out.push('sources:');
        for (const s of item.sources)
            out.push(`  - session: ${scalar(s.session)}`, `    message: ${scalar(s.message)}`, `    at: ${time(s.at)}`, `    quote: ${scalar(s.quote)}`);
    }
    if (item.state === 'Deleted') out.push('state: deleted', `deletedBy: ${scalar(item.deletedBy)}`, `deletedAt: ${time(item.deletedAt)}`);
    out.push('---', '', text);
    return `${out.join('\n')}\n`;
}
