import { CstUtils, isLeafCstNode, type AstNode, type CstNode, type LeafCstNode } from 'langium';
import * as ast from './generated/ast.js';
import { createStormingServices } from './module.js';

/** Lexer or parser errors: the file is not formatted (Modeling's printer has its own, for `.dt` files). */
export class FormatError extends Error {}

/**
 * `dt fmt` for `.dtes`: the one canonical layout of a storming file, in the spirit of Modeling's `.dt` formatter
 * (its `infrastructure/syntax/format.ts`). The printer keeps every token and comment in order and only decides the whitespace between
 * them, except that an empty `{}` of an element is dropped (it means the same as no body).
 *
 * The rules:
 * - 2 spaces per level; one blank line between stormings.
 * - Every element of a storming, every timeline of a stage, every clause of an element's body, every step of a
 *   timeline (its `then` included) and every event of a group on its own line; a stage's `after` stays on its line. Up to one blank line the author wrote between them is kept, none after `{` or before `}`.
 * - An element without clauses is one line (`event SlotReleased "配送枠が解放された"`); with clauses, its body is a block.
 * - No space around the dots of a `ref` path, nor around the hyphens of a `level` (`level big-picture`).
 * - Clauses go in one canonical order (ADR 0032), each with its comments (those on lines of their own above it and the
 *   one after it on its line): `ref`, then the relations `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `from`,
 *   then `status`, `resolution` and `level`; clauses of one kind keep their order. Repeated relations of one keyword
 *   are one clause (`by A` and `by B` → `by A, B`, unless a comment is on one of them; `handledBy` and a hotspot's `on`,
 *   which take one, aside), with a
 *   space after each comma and none before it.
 * - A comment on the line of a token stays there, one space after it; other comments stay on their own line.
 */

const INDENT = 2;
/** Indentation added after a line break forced by a comment where the layout has none. */
const CONTINUATION = 4;

type SepKind = 'none' | 'space' | 'line' | 'member' | 'blank';

/**
 * Whitespace before a token. `line`: a line break; `member`: a line break, plus a blank line when the author wrote one;
 * `blank`: always a blank line. `indent` is the indentation after a line break (also one forced by a comment).
 */
interface Sep {
    kind: SepKind;
    indent?: number;
}

interface Token {
    text: string;
    offset: number;
    end: number;
    leaf: LeafCstNode;
}

interface Comment {
    text: string;
    offset: number;
    end: number;
}

const JOINERS = new Set(['.', '-']);
const inlineSep = (a: Token, b: Token): 'none' | 'space' => (JOINERS.has(a.text) || JOINERS.has(b.text) || b.text === ',' ? 'none' : 'space');

const leavesOf = (cst: CstNode): LeafCstNode[] =>
    CstUtils.streamCst(cst)
        .filter((n): n is LeafCstNode => isLeafCstNode(n) && !n.hidden)
        .toArray();

let services: ReturnType<typeof createStormingServices>['EventStorming'] | undefined;

/**
 * Formats the text of a `.dtes` file. Throws {@link FormatError} when it has lexer or parser errors (unknown references
 * and other validation errors do not matter). The result is checked to have the same tokens and comments as the input
 * (up to the dropped `{}`); a mismatch is an internal error.
 */
export function formatStorming(input: string): string {
    services ??= createStormingServices().EventStorming;
    const first = services.parser.LangiumParser.parse<ast.EsFile>(input);
    if (first.lexerErrors.length || first.parserErrors.length) {
        throw new FormatError(first.lexerErrors[0]?.message ?? first.parserErrors[0].message);
    }
    const text = inCanonicalOrder(input, first.value, commentsOf(input));
    const parsed = text === input ? first : services.parser.LangiumParser.parse<ast.EsFile>(text);
    const comments = commentsOf(text);
    const tokens: Token[] = parsed.value.$cstNode
        ? leavesOf(parsed.value.$cstNode).map((leaf) => ({ text: leaf.text, offset: leaf.offset, end: leaf.end, leaf }))
        : [];
    const layout = new Layout(text, tokens, comments);
    layout.file(parsed.value);
    const out = layout.print();
    verify(text, out, tokens, comments, layout);
    return out;
}

const commentsOf = (text: string): Comment[] =>
    services!.parser.Lexer.tokenize(text).hidden.map((t) => ({
        text: t.image,
        offset: t.startOffset,
        end: t.startOffset + t.image.length,
    }));

/** The rank of a clause in the canonical order of a body (ADR 0032); `actor` and `target` (S023) where `by` and `handledBy` go. */
const CLAUSE_RANK: Record<string, number> = {
    ref: 0,
    by: 1,
    actor: 1,
    reads: 2,
    handledBy: 3,
    target: 3,
    emits: 4,
    on: 5,
    issues: 6,
    from: 7,
    status: 8,
    resolution: 9,
    level: 10,
};
const rankOf = (c: ast.EsClause): number =>
    CLAUSE_RANK[
        ast.isEsRelationClause(c)
            ? c.keyword
            : ast.isEsRefClause(c)
              ? 'ref'
              : ast.isEsStatusClause(c)
                ? 'status'
                : ast.isEsLevelClause(c)
                  ? 'level'
                  : 'resolution'
    ]!;

/**
 * The text with the clauses of every body in the canonical order (`CLAUSE_RANK`, stable). Each clause moves with its
 * comments: those between it and the clause before it, and one that starts on its line after it. A clause moved after
 * a line comment starts a line of its own.
 */
function inCanonicalOrder(text: string, file: ast.EsFile, comments: readonly Comment[]): string {
    const edits: { from: number; to: number; text: string }[] = [];
    const hasComment = (from: number, to: number): boolean => comments.some((k) => k.offset >= from && k.offset < to);
    for (const storming of file.stormings) {
        for (const el of storming.elements) {
            if (!ast.isEsNode(el) || el.clauses.length < 2) continue;
            const ranks = el.clauses.map(rankOf);
            const open = el.$cstNode && CstUtils.streamCst(el.$cstNode).find((n) => isLeafCstNode(n) && n.text === '{' && n.astNode === el);
            if (!open) continue;
            type Chunk = { text: string; rank: number; lineComment: boolean; clause: ast.EsClause; start: number; end: number; i: number };
            const chunks: Chunk[] = [];
            let start = open.end;
            for (const [i, c] of el.clauses.entries()) {
                let end = c.$cstNode!.end;
                let lineComment = false;
                // the comment after the clause on its line
                const after = comments.find((k) => k.offset >= end);
                if (after && /^[ \t]*$/.test(text.slice(end, after.offset))) {
                    end = after.end;
                    lineComment = after.text.startsWith('//');
                }
                chunks.push({ text: text.slice(start, end), rank: ranks[i]!, lineComment, clause: c, start, end, i });
                start = end;
            }
            const sorted = [...chunks].sort((a, b) => a.rank - b.rank || a.i - b.i);
            // one keyword, one clause: `by A` and `by B` (each without a comment) are written `by A, B` (a second
            // `handledBy` or hotspot `on` is S004: left as it is)
            const keywordOf = (c: ast.EsClause): string | undefined => (ast.isEsRelationClause(c) ? c.keyword : undefined);
            const merged: Chunk[] = [];
            for (const c of sorted) {
                const last = merged.at(-1);
                const keyword = keywordOf(c.clause);
                const mergeable =
                    last &&
                    keyword !== undefined &&
                    !ast.isEsHotspot(el) &&
                    keyword !== 'handledBy' &&
                    keywordOf(last.clause) === keyword &&
                    !last.lineComment &&
                    last.end === last.clause.$cstNode!.end &&
                    !hasComment(c.start, c.end);
                if (!mergeable) {
                    merged.push({ ...c });
                    continue;
                }
                const cst = c.clause.$cstNode!;
                const keywordLeaf = CstUtils.streamCst(cst).find((n) => isLeafCstNode(n) && n.text === keyword)!;
                last.text += `, ${text.slice(keywordLeaf.end, cst.end).trim()}`;
            }
            if (merged.length === chunks.length && merged.every((c, k) => c.i === k)) continue;
            let out = '';
            merged.forEach((c, k) => {
                const prev = merged[k - 1];
                out += prev?.lineComment && !/^[ \t]*(\r?\n)/.test(c.text) ? `\n${c.text}` : c.text;
            });
            const last = merged.at(-1)!;
            if (last.lineComment && !/^[ \t]*\r?\n/.test(text.slice(start))) out += '\n';
            edits.push({ from: open.end, to: start, text: out });
        }
    }
    let result = text;
    for (const e of edits.sort((a, b) => b.from - a.from)) result = result.slice(0, e.from) + e.text + result.slice(e.to);
    return result;
}

/** The input's tokens without the dropped ones, and its comments, must be exactly those of the output. */
function verify(input: string, output: string, tokens: Token[], comments: Comment[], layout: Layout): void {
    const parsed = services!.parser.LangiumParser.parse<ast.EsFile>(output);
    const expected = tokens.filter((_, i) => !layout.drop.has(i)).map((t) => t.text);
    const actual = parsed.value.$cstNode ? leavesOf(parsed.value.$cstNode).map((l) => l.text) : [];
    const outComments = services!.parser.Lexer.tokenize(output).hidden.map((t) => t.image);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (
        parsed.lexerErrors.length ||
        parsed.parserErrors.length ||
        !same(expected, actual) ||
        !same(
            comments.map((c) => c.text),
            outComments,
        )
    ) {
        throw new Error(`internal error: formatting would change the file's tokens (${input.length} characters)`);
    }
}

class Layout {
    readonly sep = new Map<number, Sep>();
    readonly drop = new Set<number>();
    /** Closing braces of blocks: a comment on its own line before one is indented like the block's members. */
    private readonly closers = new Set<number>();

    constructor(
        private readonly text: string,
        private readonly tokens: Token[],
        private readonly comments: Comment[],
    ) {}

    private first(node: AstNode): number {
        const cst = node.$cstNode!;
        return this.tokens.findIndex((t) => t.offset >= cst.offset);
    }

    /** The keyword tokens of a node itself (not of its children). */
    private keywords(node: AstNode, text: string): number[] {
        const cst = node.$cstNode!;
        const out: number[] = [];
        this.tokens.forEach((t, i) => {
            if (t.offset >= cst.offset && t.end <= cst.end && t.text === text && t.leaf.astNode === node) out.push(i);
        });
        return out;
    }

    private set(i: number, kind: SepKind, indent?: number): void {
        this.sep.set(i, { kind, indent });
    }

    /** Whether a comment lies between two tokens. */
    private hasComment(from: number, to: number): boolean {
        const start = this.tokens[from].offset;
        const end = this.tokens[to].end;
        return this.comments.some((c) => c.offset > start && c.offset < end);
    }

    // ---- structure ----

    file(file: ast.EsFile): void {
        file.stormings.forEach((s, i) => {
            this.set(this.first(s), i > 0 ? 'blank' : 'member', 0);
            this.block(s, s.elements, 0);
            for (const el of s.elements) this.element(el, INDENT);
        });
    }

    /** A `{ … }` of members, one per line; `{}` when empty. */
    private block(node: AstNode, members: AstNode[], indent: number): void {
        const open = this.keywords(node, '{')[0];
        const close = this.keywords(node, '}').at(-1);
        if (open === undefined || close === undefined) return;
        this.closers.add(close);
        if (!members.length) {
            this.set(close, this.hasComment(open, close) ? 'line' : 'none', indent);
            return;
        }
        members.forEach((m, i) => this.set(this.first(m), i === 0 ? 'line' : 'member', indent + INDENT));
        this.set(close, 'line', indent);
    }

    private element(el: ast.EsElement, indent: number): void {
        if (ast.isEsStage(el)) {
            this.block(el, el.timelines, indent);
            for (const t of el.timelines) this.element(t, indent + INDENT);
            return;
        }
        if (ast.isEsTimeline(el)) {
            // `then <Event>` closes the timeline, on a line of its own like a step
            this.block(el, el.rejoin ? [...el.steps, el.rejoin] : el.steps, indent);
            for (const g of el.steps.filter(ast.isEsGroup)) this.block(g, g.events, indent + INDENT);
            return;
        }
        const open = this.keywords(el, '{')[0];
        const close = this.keywords(el, '}').at(-1);
        if (!el.clauses.length && open !== undefined && close !== undefined && !this.hasComment(open, close)) {
            this.drop.add(open);
            this.drop.add(close);
            return;
        }
        this.block(el, el.clauses, indent);
    }

    // ---- printing (as in Modeling's infrastructure/syntax/format.ts) ----

    print(): string {
        type Item = { offset: number; end: number; token?: number; comment?: Comment };
        const items: Item[] = [
            ...this.tokens.map((t, i) => ({ offset: t.offset, end: t.end, token: i })),
            ...this.comments.map((c) => ({ offset: c.offset, end: c.end, comment: c })),
        ];
        items.sort((a, b) => a.offset - b.offset);
        const nextToken = (k: number): number | undefined => {
            for (let j = k + 1; j < items.length; j++) {
                const i = items[j].token;
                if (i !== undefined && !this.drop.has(i)) return i;
            }
            return undefined;
        };
        let out = '';
        let started = false;
        let lineIndent = 0;
        let lastEnd = 0;
        let prev: Token | undefined;
        /** A line comment was written: the next token starts a new line. */
        let broken = false;
        /** The last thing written is a comment on its own line. */
        let afterOwnLine = false;
        const newline = (blank: boolean, indent: number) => {
            out += `\n${blank ? '\n' : ''}${' '.repeat(indent)}`;
        };

        items.forEach((item, k) => {
            const gap = this.text.slice(lastEnd, item.offset);
            const blankBefore = (gap.match(/\n/g)?.length ?? 0) >= 2;
            if (item.comment) {
                const c = item.comment;
                lastEnd = c.end;
                if (!started) {
                    out += c.text;
                    started = broken = afterOwnLine = true;
                    return;
                }
                if (!gap.includes('\n')) {
                    out += ` ${c.text}`;
                    if (c.text.startsWith('//')) broken = true;
                    return;
                }
                const next = nextToken(k);
                const s = next === undefined ? { kind: 'member' as const, indent: 0 } : this.sepOf(next, prev);
                const closer = next !== undefined && this.closers.has(next);
                if (s.indent === undefined) newline(false, lineIndent + CONTINUATION);
                else {
                    const blank = afterOwnLine || s.kind === 'member' || closer ? blankBefore : s.kind === 'blank';
                    newline(blank, s.indent + (closer ? INDENT : 0));
                }
                out += c.text;
                broken = afterOwnLine = true;
                return;
            }
            const i = item.token!;
            if (this.drop.has(i)) return;
            lastEnd = item.end;
            const t = this.tokens[i];
            const s = this.sepOf(i, prev);
            if (!started) {
                out += t.text;
            } else if (s.kind === 'line' || s.kind === 'member' || s.kind === 'blank') {
                const blank = afterOwnLine ? blankBefore && !this.closers.has(i) : s.kind === 'blank' || (s.kind === 'member' && blankBefore);
                newline(blank, s.indent!);
                lineIndent = s.indent!;
                out += t.text;
            } else if (broken) {
                newline(false, s.indent ?? lineIndent + CONTINUATION);
                out += t.text;
            } else {
                out += (s.kind === 'space' ? ' ' : '') + t.text;
            }
            started = true;
            broken = afterOwnLine = false;
            prev = t;
        });
        return started ? `${out}\n` : '';
    }

    private sepOf(i: number, prev: Token | undefined): Sep {
        const s = this.sep.get(i);
        if (s) return s;
        return { kind: prev ? inlineSep(prev, this.tokens[i]) : 'none' };
    }
}
