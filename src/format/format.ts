import { CstUtils, isLeafCstNode, type AstNode, type CstNode, type LeafCstNode } from 'langium';
import * as ast from '../language/generated/ast.js';
import { createDomainServices } from '../language/domain-module.js';

/**
 * `dt fmt`: the one canonical layout of a `.dt` file. The printer works on the tokens of the parsed file: it keeps every
 * token and comment in order and only decides the whitespace between them, except for three normalizations that do
 * not change the model (`[0..1]` → `?`, `[1..1]` → nothing, no commas between enum values or between transitions).
 *
 * The rules (also in the guide, "Formatting"):
 * - 2 spaces per level; every member of a `{ … }` block on its own line; up to one blank line the author wrote between
 *   members is kept, none after `{` or before `}`; one blank line between top-level contexts.
 * - An enum stays on one line (`{ A "a" B "b" }`) unless it has comments or does not fit in {@link LINE_WIDTH} columns.
 * - An expression body stays inline (`{ expr }`) unless it has comments or its line does not fit; then the expression
 *   goes on its own line. An expression itself is never broken.
 * - A command stays on one line when it has at most one clause (a transition, `requires`, `changes`, `emits` with one
 *   event, `errors`), no comments, and fits; otherwise every clause goes on its own line, indented one level, and the
 *   events of `emits` one per line, aligned after `emits `.
 * - Parameters, `with`, `changes` and `errors` lists stay on one line.
 * - A comment on the line of a token stays there, one space after it; other comments stay on their own line.
 */

export const LINE_WIDTH = 120;
const INDENT = 2;
/** Indentation added after a line break forced by a comment where the layout has none. */
const CONTINUATION = 4;

/** Lexer or parser errors: the file is not formatted. */
export class FormatError extends Error {}

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

const FUNCTIONS = new Set(['count', 'exists', 'length', 'matches', 'unique', 'contains', 'all', 'any']);

/** The whitespace between two tokens on one line. */
function inlineSep(a: Token, b: Token): 'none' | 'space' {
    if ([')', ',', ']', '?', '.', '..', ':', '['].includes(b.text)) return 'none';
    if (['(', '[', '.', '..'].includes(a.text)) return 'none';
    if (b.text === '(' && a.leaf.astNode === b.leaf.astNode && (ast.isCommand(a.leaf.astNode) || FUNCTIONS.has(a.text))) return 'none';
    if (a.text === '-' && (ast.isIntLiteral(a.leaf.astNode) || ast.isDecimalLiteral(a.leaf.astNode))) return 'none';
    return 'space';
}

/** Columns a text takes in a monospace font: East Asian wide characters take two. */
export function displayWidth(text: string): number {
    let w = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        const wide =
            (cp >= 0x1100 && cp <= 0x115f) ||
            (cp >= 0x2e80 && cp <= 0xa4cf) ||
            (cp >= 0xac00 && cp <= 0xd7a3) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0xfe30 && cp <= 0xfe4f) ||
            (cp >= 0xff00 && cp <= 0xff60) ||
            (cp >= 0xffe0 && cp <= 0xffe6) ||
            cp >= 0x20000;
        w += wide ? 2 : 1;
    }
    return w;
}

const leavesOf = (cst: CstNode): LeafCstNode[] =>
    CstUtils.streamCst(cst)
        .filter((n): n is LeafCstNode => isLeafCstNode(n) && !n.hidden)
        .toArray();

const tokenOf = (leaf: LeafCstNode): Token => ({ text: leaf.text, offset: leaf.offset, end: leaf.end, leaf });

/** An expression on one line, spaced as `dt fmt` writes it, without comments: the `source` of the Typed Model. */
export function expressionText(node: AstNode): string {
    if (!node.$cstNode) return '';
    const tokens = leavesOf(node.$cstNode).map(tokenOf);
    return tokens.map((t, i) => (i > 0 && inlineSep(tokens[i - 1], t) === 'space' ? ' ' : '') + t.text).join('');
}

let services: ReturnType<typeof createDomainServices>['Domain'] | undefined;

/**
 * Formats the text of a `.dt` file. Throws {@link FormatError} when it has lexer or parser errors. The result is checked
 * to have the same tokens and comments as the input (up to the normalizations); a mismatch is an internal error.
 */
export function formatDomain(text: string): string {
    services ??= createDomainServices().Domain;
    const parsed = services.parser.LangiumParser.parse<ast.Model>(text);
    if (parsed.lexerErrors.length || parsed.parserErrors.length) {
        throw new FormatError(parsed.lexerErrors[0]?.message ?? parsed.parserErrors[0].message);
    }
    const comments: Comment[] = services.parser.Lexer.tokenize(text).hidden.map((t) => ({ text: t.image, offset: t.startOffset, end: t.startOffset + t.image.length }));
    const tokens = parsed.value.$cstNode ? leavesOf(parsed.value.$cstNode).map(tokenOf) : [];
    const layout = new Layout(text, tokens, comments);
    layout.model(parsed.value);
    const out = layout.print();
    verify(text, out, tokens, comments, layout);
    return out;
}

/** The input's tokens after the normalizations, and its comments, must be exactly those of the output. */
function verify(input: string, output: string, tokens: Token[], comments: Comment[], layout: Layout): void {
    const parsed = services!.parser.LangiumParser.parse<ast.Model>(output);
    const expected = tokens.flatMap((t, i) => (layout.drop.has(i) ? [] : [layout.replace.get(i) ?? t.text]));
    const actual = parsed.value.$cstNode ? leavesOf(parsed.value.$cstNode).map((l) => l.text) : [];
    const outComments = services!.parser.Lexer.tokenize(output).hidden.map((t) => t.image);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (parsed.lexerErrors.length || parsed.parserErrors.length || !same(expected, actual) || !same(comments.map((c) => c.text), outComments)) {
        throw new Error(`internal error: formatting would change the file's tokens (${input.length} characters)`);
    }
}

class Layout {
    readonly sep = new Map<number, Sep>();
    readonly drop = new Set<number>();
    readonly replace = new Map<number, string>();
    /** Closing braces of blocks: a comment on its own line before one is indented like the block's members. */
    private readonly closers = new Set<number>();

    constructor(
        private readonly text: string,
        private readonly tokens: Token[],
        private readonly comments: Comment[],
    ) {}

    // ---- token lookup ----

    private first(node: AstNode): number {
        const cst = node.$cstNode!;
        return this.tokens.findIndex((t) => t.offset >= cst.offset);
    }

    private last(node: AstNode): number {
        const cst = node.$cstNode!;
        return this.tokens.findLastIndex((t) => t.end <= cst.end);
    }

    /** The keyword tokens of a node itself (not of its children). */
    private keywords(node: AstNode, text: string): number[] {
        const out: number[] = [];
        for (let i = this.first(node); i <= this.last(node); i++) {
            if (this.tokens[i].text === text && this.tokens[i].leaf.astNode === node) out.push(i);
        }
        return out;
    }

    private set(i: number, kind: SepKind, indent?: number): void {
        this.sep.set(i, { kind, indent });
    }

    /** Whether a comment lies between two tokens (inclusive). */
    private hasComment(from: number, to: number): boolean {
        const start = this.tokens[from].offset;
        const end = this.tokens[to].end;
        return this.comments.some((c) => c.offset > start && c.offset < end);
    }

    /** The width of tokens on one line. */
    private width(from: number, to: number): number {
        let w = 0;
        let prev: Token | undefined;
        for (let i = from; i <= to; i++) {
            if (this.drop.has(i)) continue;
            const t = this.tokens[i];
            if (prev && inlineSep(prev, t) === 'space') w += 1;
            w += displayWidth(this.replace.get(i) ?? t.text);
            prev = t;
        }
        return w;
    }

    private fits(indent: number, from: number, to: number): boolean {
        return !this.hasComment(from, to) && indent + this.width(from, to) <= LINE_WIDTH;
    }

    // ---- structure ----

    model(model: ast.Model): void {
        model.contexts.forEach((ctx, i) => {
            this.set(this.first(ctx), i > 0 ? 'blank' : 'member', 0);
            this.block(ctx, sorted([...ctx.elements, ...ctx.terms]), 0);
            for (const m of [...ctx.elements, ...ctx.terms]) this.element(m, INDENT);
        });
        this.multiplicities();
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

    private element(node: AstNode, indent: number): void {
        const inner = indent + INDENT;
        if (ast.isTerms(node)) this.block(node, node.entries, indent);
        else if (ast.isIdType(node) || ast.isPrimitiveDecl(node)) {
            if (node.constraint) this.expressionBody(node, indent);
            else {
                this.block(node, node.invariants, indent);
                for (const inv of node.invariants) this.expressionBody(inv, inner);
            }
        } else if (ast.isEnumDecl(node)) this.enumeration(node, indent);
        else if (ast.isUnionDecl(node)) {
            this.block(node, node.variants, indent);
            for (const v of node.variants) this.element(v, inner);
        } else if (ast.isAggregate(node)) {
            this.block(node, node.members, indent);
            for (const m of node.members) this.element(m, inner);
        } else if (ast.isValueObject(node) || ast.isFieldSet(node) || ast.isEntity(node) || ast.isVariant(node) || ast.isState(node)) {
            this.block(node, node.members, indent);
            for (const m of node.members) if (ast.isInvariant(m)) this.expressionBody(m, inner);
        } else if (ast.isEventDecl(node) || ast.isErrorDecl(node)) this.block(node, node.members, indent);
        else if (ast.isInvariant(node)) this.expressionBody(node, indent);
        else if (ast.isCommand(node)) this.command(node, indent);
        else if (ast.isPolicy(node)) this.policy(node, indent);
    }

    /** A policy stays on one line if it fits and has no comments; else `when …` goes on a line of its own, one level deeper. */
    private policy(node: ast.Policy, indent: number): void {
        if (this.fits(indent, this.first(node), this.last(node))) return;
        const when = this.keywords(node, 'when')[0];
        if (when !== undefined) this.set(when, 'line', indent + INDENT);
    }

    private enumeration(node: ast.EnumDecl, indent: number): void {
        for (const comma of this.keywords(node, ',')) this.drop.add(comma);
        const close = this.keywords(node, '}')[0];
        if (!node.values.length || this.fits(indent, this.first(node), close)) {
            if (!node.values.length) this.set(close, 'none', indent);
            this.closers.add(close);
            return;
        }
        this.block(node, node.values, indent);
    }

    /** `{ expr }` of an invariant, a requirement or a domain primitive: inline when its line fits, else a block. */
    private expressionBody(node: ast.Invariant | ast.Requirement | ast.IdType | ast.PrimitiveDecl, indent: number): void {
        const open = this.keywords(node, '{')[0];
        const close = this.keywords(node, '}')[0];
        if (open === undefined || close === undefined) return;
        if (this.fits(indent, this.first(node), this.last(node))) return;
        this.set(open + 1, 'line', indent + INDENT);
        this.set(close, 'line', indent);
        this.closers.add(close);
    }

    private command(cmd: ast.Command, indent: number): void {
        const clauses = [
            ...cmd.transitions.map((t) => this.first(t)),
            ...cmd.requirements.map((r) => this.first(r)),
            ...(['changes', 'emits', 'errors'] as const).flatMap((k) => this.keywords(cmd, k)),
        ];
        if (cmd.transitions.length) {
            const from = this.first(cmd.transitions[0]);
            const to = this.last(cmd.transitions.at(-1)!);
            for (const comma of this.keywords(cmd, ',')) if (comma > from && comma < to) this.drop.add(comma);
        }
        if (clauses.length <= 1 && cmd.emits.length <= 1 && this.fits(indent, this.first(cmd), this.last(cmd))) return;
        for (const c of clauses) this.set(c, 'line', indent + INDENT);
        cmd.emits.forEach((e, i) => {
            if (i > 0) this.set(this.first(e), 'line', indent + INDENT + 'emits '.length);
        });
        for (const r of cmd.requirements) this.expressionBody(r, indent + INDENT);
    }

    /** `[0..1]` → `?`, `[1..1]` → nothing. */
    private multiplicities(): void {
        const seen = new Set<AstNode>();
        for (const t of this.tokens) {
            const m = t.leaf.astNode;
            if (!ast.isMultiplicity(m) || seen.has(m) || m.optional || m.unbounded || m.upper !== 1 || (m.lower !== 0 && m.lower !== 1)) continue;
            seen.add(m);
            const from = this.first(m);
            for (let i = from; i <= this.last(m); i++) this.drop.add(i);
            if (m.lower === 0) {
                this.drop.delete(from);
                this.replace.set(from, '?');
            }
        }
    }

    // ---- printing ----

    print(): string {
        type Item = { offset: number; end: number; token?: number; comment?: Comment };
        const items: Item[] = [...this.tokens.map((t, i) => ({ offset: t.offset, end: t.end, token: i })), ...this.comments.map((c) => ({ offset: c.offset, end: c.end, comment: c }))];
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
            const text = this.replace.get(i) ?? t.text;
            const s = this.sepOf(i, prev);
            if (!started) {
                out += text;
            } else if (s.kind === 'line' || s.kind === 'member' || s.kind === 'blank') {
                const blank = afterOwnLine ? blankBefore && !this.closers.has(i) : s.kind === 'blank' || (s.kind === 'member' && blankBefore);
                newline(blank, s.indent!);
                lineIndent = s.indent!;
                out += text;
            } else if (broken) {
                newline(false, s.indent ?? lineIndent + CONTINUATION);
                out += text;
            } else {
                out += (s.kind === 'space' ? ' ' : '') + text;
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

const sorted = (nodes: AstNode[]): AstNode[] => [...nodes].sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset);
