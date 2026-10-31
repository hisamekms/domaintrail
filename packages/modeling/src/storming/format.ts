import { CstUtils, isLeafCstNode, type AstNode, type CstNode, type LeafCstNode } from 'langium';
import * as ast from '../language/generated/ast.js';
import { FormatError } from '../format/format.js';
import { createStormingServices } from './language/module.js';

/**
 * `dt fmt` for `.dtes`: the one canonical layout of a storming file, in the spirit of the `.dt` formatter
 * (`../format/format.ts`). The printer keeps every token and comment in order and only decides the whitespace between
 * them, except that an empty `{}` of an element is dropped (it means the same as no body).
 *
 * The rules:
 * - 2 spaces per level; one blank line between stormings.
 * - Every element of a storming, every clause of an element's body, every step of a timeline and every event of a group
 *   on its own line. Up to one blank line the author wrote between them is kept, none after `{` or before `}`.
 * - An element without clauses is one line (`event SlotReleased "配送枠が解放された"`); with clauses, its body is a block.
 * - No space around the dots of a `ref` path.
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

const inlineSep = (a: Token, b: Token): 'none' | 'space' => (a.text === '.' || b.text === '.' ? 'none' : 'space');

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
export function formatStorming(text: string): string {
    services ??= createStormingServices().EventStorming;
    const parsed = services.parser.LangiumParser.parse<ast.EsFile>(text);
    if (parsed.lexerErrors.length || parsed.parserErrors.length) {
        throw new FormatError(parsed.lexerErrors[0]?.message ?? parsed.parserErrors[0].message);
    }
    const comments: Comment[] = services.parser.Lexer.tokenize(text).hidden.map((t) => ({
        text: t.image,
        offset: t.startOffset,
        end: t.startOffset + t.image.length,
    }));
    const tokens: Token[] = parsed.value.$cstNode
        ? leavesOf(parsed.value.$cstNode).map((leaf) => ({ text: leaf.text, offset: leaf.offset, end: leaf.end, leaf }))
        : [];
    const layout = new Layout(text, tokens, comments);
    layout.file(parsed.value);
    const out = layout.print();
    verify(text, out, tokens, comments, layout);
    return out;
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
        if (ast.isEsTimeline(el)) {
            this.block(el, el.steps, indent);
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

    // ---- printing (as in ../format/format.ts) ----

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
