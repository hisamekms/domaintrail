// `dt migrate domain`: rewrites `.dt` sources of the current expression syntax to Phase 2's TS-like syntax
// (docs/plans/formal-verification/language-revision.md §4). The rewrite edits only the tokens it changes and inserts
// parentheses where it needs them, so comments and layout stay. This file holds the logical operators' group.
import { AstUtils, CstUtils, isLeafCstNode, type AstNode, type LeafCstNode } from 'langium';
import * as ast from './generated/ast.js';
import { createDomainServices } from './domain-module.js';

/** One rewritten construct, for the migration report. */
export interface DomainMigrationRewrite {
    readonly line: number;
    readonly from: string;
    readonly to: string;
}

export interface DomainMigration {
    /** The migrated text; the input itself when it does not parse or has nothing to rewrite. */
    readonly text: string;
    readonly rewrites: readonly DomainMigrationRewrite[];
    /** Whether the input parsed; a source with syntax errors is left as it is. */
    readonly parsed: boolean;
}

/** A replacement of `[start, end)`; an insertion has `start === end`. */
interface Edit {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

let services: ReturnType<typeof createDomainServices>['Domain'] | undefined;

/** The keyword token of a node itself (not of its children), by its text. */
function ownToken(node: AstNode, texts: readonly string[]): LeafCstNode | undefined {
    if (!node.$cstNode) return undefined;
    return CstUtils.streamCst(node.$cstNode)
        .filter((n): n is LeafCstNode => isLeafCstNode(n) && !n.hidden && n.astNode === node && texts.includes(n.text))
        .head();
}

/** Every own token of a node with a text, in source order. */
function ownTokens(node: AstNode, text: string): LeafCstNode[] {
    if (!node.$cstNode) return [];
    return CstUtils.streamCst(node.$cstNode)
        .filter((n): n is LeafCstNode => isLeafCstNode(n) && !n.hidden && n.astNode === node && n.text === text)
        .toArray();
}

/** Whether an expression can be the receiver of `.m(…)` as written: a name, a member, a call, a literal, or `( … )`. */
const postfixSafe = (node: AstNode, written: string): boolean =>
    written.trimStart().startsWith('(') || !(ast.isBinaryExpr(node) || ast.isNotExpr(node) || ast.isRangeExpr(node));

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

const childrenOf = (node: AstNode): AstNode[] => AstUtils.streamContents(node).toArray();

const rangeOf = (node: AstNode): { start: number; end: number } => ({ start: node.$cstNode!.offset, end: node.$cstNode!.end });

/** The spellings the parser still reads only so that `dt migrate domain` can rewrite them, with their replacement. */
export const LEGACY_SPELLINGS: Readonly<Record<string, string>> = { and: '&&', or: '||', not: '!', implies: '!(p) || q' };

/** The legacy operator tokens of a parsed model, in source order. */
export function legacyTokens(root: AstNode): LeafCstNode[] {
    const out: LeafCstNode[] = [];
    for (const node of AstUtils.streamAst(root)) {
        const op = ast.isBinaryExpr(node) ? ownToken(node, ['and', 'or', 'implies']) : ast.isNotExpr(node) ? ownToken(node, ['not']) : undefined;
        if (op) out.push(op);
    }
    return out.sort((a, b) => a.offset - b.offset);
}

/**
 * Rewrites the logical operators: `and` → `&&`, `or` → `||`, `not x` → `!x`, and `p implies q` → `!(p) || q`. The
 * grammar gives `!` the place of `not` and `||` the place of `or`; `implies` is the loosest operator and associates to
 * the left, so `!(p) || q` keeps the meaning wherever the implication stood, and a chain `p implies q implies r` becomes
 * `!(!(p) || q) || r`. Idempotent: the new forms are not rewritten again.
 */
export function migrateDomain(text: string): DomainMigration {
    services ??= createDomainServices().Domain;
    const result = services.parser.LangiumParser.parse<ast.Model>(text);
    if (result.lexerErrors.length || result.parserErrors.length) return { text, rewrites: [], parsed: false };

    const edits: Edit[] = [];
    const rewrites: DomainMigrationRewrite[] = [];
    const visit = (node: AstNode): void => {
        if (ast.isBinaryExpr(node)) {
            const op = ownToken(node, ['and', 'or', 'implies']);
            if (op?.text === 'and' || op?.text === 'or') {
                const to = op.text === 'and' ? '&&' : '||';
                edits.push({ start: op.offset, end: op.end, text: to });
                rewrites.push({ line: lineAt(text, op.offset), from: op.text, to });
            } else if (op?.text === 'implies') {
                const left = rangeOf(node.left);
                edits.push({ start: left.start, end: left.start, text: '!(' }, { start: left.end, end: left.end, text: ')' });
                edits.push({ start: op.offset, end: op.end, text: '||' });
                rewrites.push({ line: lineAt(text, op.offset), from: 'p implies q', to: '!(p) || q' });
            }
        } else if (
            ast.isCountExpr(node) ||
            ast.isLengthExpr(node) ||
            ast.isQuantifierExpr(node) ||
            ast.isContainsExpr(node) ||
            ast.isUniqueExpr(node) ||
            ast.isMatchesExpr(node)
        ) {
            // `fn(r, …)` → `r.method(…)`: drop `fn(`, put `.method(` where the first `,` was (or `.length` / `.unique()`
            // in place of the closing `)` of a one-argument call), and parenthesize `r` when it is not postfix
            const name = ast.isQuantifierExpr(node) ? node.quantifier : ownToken(node, ['count', 'length', 'contains', 'unique', 'matches'])?.text;
            const receiver =
                ast.isCountExpr(node) || ast.isContainsExpr(node) || ast.isUniqueExpr(node) || ast.isQuantifierExpr(node) ? node.collection : node.operand;
            const open = ownTokens(node, '(')[0];
            const comma = ownTokens(node, ',')[0];
            const close = ownTokens(node, ')').at(-1);
            const fn =
                node.$cstNode && name ? CstUtils.streamCst(node.$cstNode).find((n) => isLeafCstNode(n) && n.astNode === node && n.text === name) : undefined;
            if (open && close && fn && receiver.$cstNode) {
                // the receiver as written, its own parentheses included, up to the `,` or the `)`
                const written = text.slice(open.end, comma ? comma.offset : close.offset);
                const r = { end: open.end + written.trimEnd().length };
                const wrap = !postfixSafe(receiver, written);
                const method = { all: 'every', any: 'some', contains: 'includes', count: 'length', length: 'length', unique: 'unique', matches: 'matches' }[
                    name!
                ]!;
                edits.push({ start: fn.offset, end: open.end, text: wrap ? '(' : '' });
                if (comma) {
                    // `, x => p` / `, x` / `, "r"`: the rest of the arguments become the method's
                    const next = text.slice(comma.end).match(/^\s*/)![0].length;
                    edits.push({ start: r.end, end: comma.end + next, text: `${wrap ? ')' : ''}.${method}(` });
                } else {
                    edits.push({ start: r.end, end: close.end, text: `${wrap ? ')' : ''}.${method}${method === 'unique' ? '()' : ''}` });
                }
                rewrites.push({ line: lineAt(text, fn.offset), from: `${name}(…)`, to: `.${method}${method === 'length' ? '' : '(…)'}` });
            }
        } else if (ast.isNotExpr(node)) {
            const op = ownToken(node, ['not']);
            if (op) {
                // `not x` → `!x`: drop the spaces after the keyword; `not(x)` → `!(x)`
                const operand = rangeOf(node.operand);
                const gap = text.slice(op.end, operand.start);
                edits.push({ start: op.offset, end: /^[ \t]+$/.test(gap) ? operand.start : op.end, text: '!' });
                rewrites.push({ line: lineAt(text, op.offset), from: 'not', to: '!' });
            }
        }
        childrenOf(node).forEach(visit);
    };
    visit(result.value);
    if (!edits.length) return { text, rewrites: [], parsed: true };

    // Applied from the end. At one offset a replacement goes before an insertion (so `!(` lands in front of `!x`), and
    // insertions made earlier, by outer expressions, end up in front of those made later by inner ones.
    const ordered = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.end - a.end || b.i - a.i);
    let out = text;
    for (const e of ordered) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return { text: out, rewrites: rewrites.sort((a, b) => a.line - b.line), parsed: true };
}
