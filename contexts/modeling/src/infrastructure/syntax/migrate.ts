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
