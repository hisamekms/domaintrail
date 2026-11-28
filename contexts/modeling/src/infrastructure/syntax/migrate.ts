// `dt migrate domain`: rewrites `.dt` sources of the current expression syntax to Phase 2's TS-like syntax
// (docs/plans/formal-verification/language-revision.md §4). The rewrite edits only the tokens it changes and inserts
// parentheses where it needs them, so comments and layout stay. This file holds the logical operators' group, and the
// rewrite of owned entities' comparisons to their `id` (ADR 0042), which reads a workspace's analysis.
import { AstUtils, CstUtils, isLeafCstNode, type AstNode, type LeafCstNode } from 'langium';
import * as ast from './generated/ast.js';
import { createDomainServices } from './domain-module.js';
import type { DomainDocument } from './parse.js';
import type { ExpressionFact } from '../../domain/rules/expressions.js';
import type { Expr, Site } from '../../domain/source-model.js';
import type { Ty } from '../../domain/types.js';

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
export const LEGACY_SPELLINGS: Readonly<Record<string, string>> = {
    and: '&&',
    or: '||',
    not: '!',
    implies: '!(p) || q',
    count: 'xs.length',
    length: 'text.length',
    all: 'xs.every(x => …)',
    any: 'xs.some(x => …)',
    contains: 'xs.includes(x)',
    unique: 'xs.unique() or xs.unique(x => key, …)',
    matches: 'text.matches("pattern")',
    exists: 'x != null',
};

/** The legacy operator tokens of a parsed model, in source order. */
export function legacyTokens(root: AstNode): LeafCstNode[] {
    const out: LeafCstNode[] = [];
    for (const node of AstUtils.streamAst(root)) {
        const op = ast.isBinaryExpr(node)
            ? ownToken(node, ['and', 'or', 'implies'])
            : ast.isNotExpr(node)
              ? ownToken(node, ['not'])
              : // the function forms: only the old syntax makes these nodes (the method forms are member calls)
                ast.isCountExpr(node) || ast.isLengthExpr(node) || ast.isContainsExpr(node) || ast.isUniqueExpr(node) || ast.isMatchesExpr(node)
                ? ownToken(node, ['count', 'length', 'contains', 'unique', 'matches'])
                : ast.isQuantifierExpr(node)
                  ? ownToken(node, ['all', 'any'])
                  : ast.isExistsExpr(node)
                    ? ownToken(node, ['exists'])
                    : undefined;
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
    /** Whether a comparison put where `node` stands needs parentheses: as an operand of another comparison or range,
     *  of `!`, or as a receiver. */
    const needsParens = (node: AstNode): boolean => {
        const parent = node.$container;
        if (ast.isNotExpr(parent) || ast.isMemberAccess(parent) || ast.isRangeExpr(parent)) return true;
        return ast.isBinaryExpr(parent) && ['==', '!=', '<', '<=', '>', '>='].includes(parent.op);
    };
    const existsEdit = (node: ast.ExistsExpr, op: '!=' | '=='): void => {
        const fn = ownToken(node, ['exists']);
        const open = ownTokens(node, '(').filter((t) => !!fn && t.offset > fn.offset)[0];
        const close = ownTokens(node, ')').filter((t) => !!open && t.offset > open.offset)[0];
        if (!fn || !open || !close) return;
        const wrap = needsParens(node);
        edits.push({ start: fn.offset, end: open.end, text: wrap ? '(' : '' });
        edits.push({ start: close.offset, end: close.end, text: ` ${op} null${wrap ? ')' : ''}` });
        rewrites.push({ line: lineAt(text, fn.offset), from: 'exists(x)', to: `x ${op} null` });
    };
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
            // the parentheses written around the call are tokens of this node too: take those of the call itself
            const fn =
                node.$cstNode && name ? CstUtils.streamCst(node.$cstNode).find((n) => isLeafCstNode(n) && n.astNode === node && n.text === name) : undefined;
            const after = (t: LeafCstNode): boolean => !!fn && t.offset > fn.offset;
            const open = ownTokens(node, '(').filter(after)[0];
            const comma = ownTokens(node, ',').filter(after)[0];
            const close = ownTokens(node, ')').filter(after)[0];
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
        } else if (ast.isExistsExpr(node) && !(ast.isNotExpr(node.$container) && node.$container.operand === node)) {
            // `exists(x)` → `x != null` (parenthesized where a comparison cannot stand as it is)
            existsEdit(node, '!=');
        } else if (ast.isNotExpr(node) && ast.isExistsExpr(node.operand)) {
            // `!exists(x)`, `!(exists(x))`, `not exists(x)` → `x == null`
            const range = rangeOf(node);
            const inner = node.operand;
            const fn = ownToken(inner, ['exists']);
            const open = ownTokens(inner, '(').filter((t) => !!fn && t.offset > fn.offset)[0];
            const close = ownTokens(inner, ')').filter((t) => !!open && t.offset > open.offset)[0];
            if (fn && open && close) {
                const x = text.slice(open.end, close.offset).trim();
                const wrap = needsParens(node);
                edits.push({ start: range.start, end: range.end, text: `${wrap ? '(' : ''}${x} == null${wrap ? ')' : ''}` });
                rewrites.push({ line: lineAt(text, range.start), from: '!exists(x)', to: 'x == null' });
                return; // the operand is rewritten as a whole
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

/** A file `migrateEntityComparisons` rewrote, with what it rewrote for the report. */
export interface MigratedComparisons {
    readonly path: string;
    readonly text: string;
    readonly rewrites: readonly DomainMigrationRewrite[];
}

/** Whether a written operand takes `.id` as it stands: a name, a member, a call, or one wrapped in `( … )` as a whole. */
function receiverSafe(e: Expr, written: string): boolean {
    if (e.k === 'name' || e.k === 'member' || e.k === 'call' || e.k === 'listMethod' || e.k === 'round') return true;
    if (!written.startsWith('(') || !written.endsWith(')')) return false;
    let depth = 0;
    for (let i = 0; i < written.length; i++) {
        if (written[i] === '(') depth++;
        else if (written[i] === ')' && --depth === 0) return i === written.length - 1;
    }
    return false;
}

const isOwnedEntity = (t: Ty | undefined): t is Extract<Ty, { k: 'struct' }> => t?.k === 'struct' && t.decl.kind === 'entity';

/**
 * `dt migrate domain`, after the syntax: `==`, `!=`, `unique` and `includes` compare owned entities by all their
 * fields (ADR 0042), where they compared them by `id`. This rewrites each comparison of owned entities to the `id`
 * form it meant: `a == b` → `a.id == b.id` (and `!=`), `xs.unique()` → `xs.unique(x => x.id)`, a key of
 * `xs.unique(x => key)` that is an entity → `key.id`, and `xs.includes(e)` → `xs.some(x => x.id == e.id)`. It needs
 * the checker's types, so it reads a workspace's analysis (of the sources in the method syntax, after
 * `migrateDomain`). Value objects, unions and IDs are not touched; a second run rewrites nothing (the new forms
 * compare IDs). Only the operators and the operands' ends are edited, so comments and layout stay.
 */
export function migrateEntityComparisons(analysis: {
    readonly documents: readonly DomainDocument[];
    readonly expressionFacts: ReadonlyMap<Expr, ExpressionFact>;
    readonly resolveFile: (uri: string) => string;
}): MigratedComparisons[] {
    const byFile = new Map<string, { text: string; lines: number[]; edits: Edit[]; rewrites: DomainMigrationRewrite[] }>();
    for (const doc of analysis.documents) {
        const text = doc.textDocument.getText();
        const lines = [0];
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
        byFile.set(analysis.resolveFile(doc.uri.toString()), { text, lines, edits: [], rewrites: [] });
    }
    const typeOf = (e: Expr): Ty | undefined => analysis.expressionFacts.get(e)?.type;
    const seen = new Set<string>();
    for (const [e, fact] of analysis.expressionFacts) {
        const file = byFile.get(e.at.file);
        if (!file) continue;
        const { text, lines, edits, rewrites } = file;
        const offset = (p: Site['start']): number => lines[p.line - 1]! + p.column - 1;
        const range = (s: Site): { start: number; end: number } => ({ start: offset(s.start), end: offset(s.end) });
        const key = `${e.at.file}:${offset(e.at.start)}:${offset(e.at.end)}:${e.k}`;
        if (seen.has(key)) continue;
        /** `.id` after an operand, in parentheses where it does not take a member as written. */
        const idOf = (x: Expr): void => {
            const r = range(x.at);
            if (receiverSafe(x, text.slice(r.start, r.end))) edits.push({ start: r.end, end: r.end, text: '.id' });
            else edits.push({ start: r.start, end: r.start, text: '(' }, { start: r.end, end: r.end, text: ').id' });
        };
        /** A lambda parameter for the elements of `coll`: the entity's initial, unless the operand uses that name. */
        const param = (entity: string, avoid: string): string => {
            const used = new Set(avoid.match(/[A-Za-z_][\w]*/g) ?? []);
            for (const n of [entity[0]!.toLowerCase(), 'x']) if (/^[a-z]$/.test(n) && !used.has(n)) return n;
            let i = 2;
            while (used.has(`x${i}`)) i++;
            return `x${i}`;
        };
        const at = range(e.at); // a parenthesized expression's site includes its parentheses
        if (e.k === 'binary' && (e.op === '==' || e.op === '!=') && fact.comparison === 'entityStructural') {
            seen.add(key);
            idOf(e.left);
            idOf(e.right);
            rewrites.push({ line: e.at.start.line, from: `a ${e.op} b`, to: `a.id ${e.op} b.id` });
        } else if (e.k === 'unique') {
            const coll = typeOf(e.collection);
            const elem = coll?.k === 'list' ? coll.elem : undefined;
            if (!e.param) {
                if (!isOwnedEntity(elem)) continue;
                const c = range(e.collection.at);
                // the method form only: `migrateDomain` has rewritten the function forms
                // (the site of a parenthesized expression includes its parentheses)
                const call = /^\s*\.\s*unique\s*\(\s*\)/.exec(text.slice(c.end, at.end));
                if (!call) continue;
                seen.add(key);
                const x = param(elem.decl.name, '');
                edits.push({ start: c.end, end: c.end + call[0].length, text: `.unique(${x} => ${x}.id)` });
                rewrites.push({ line: e.at.start.line, from: 'xs.unique()', to: `xs.unique(${x} => ${x}.id)` });
            } else {
                const keys = e.keys.filter((k) => isOwnedEntity(typeOf(k)));
                if (!keys.length) continue;
                seen.add(key);
                keys.forEach(idOf);
                rewrites.push({ line: e.at.start.line, from: 'xs.unique(x => key)', to: 'xs.unique(x => key.id)' });
            }
        } else if (e.k === 'contains') {
            const coll = typeOf(e.collection);
            const elem = coll?.k === 'list' ? coll.elem : undefined;
            if (!isOwnedEntity(elem)) continue;
            const c = range(e.collection.at);
            const x = range(e.elementAt);
            if (!/^\s*\.\s*includes\s*\(\s*$/.test(text.slice(c.end, x.start)) || !/^\s*\)/.test(text.slice(x.end, at.end))) continue;
            seen.add(key);
            const v = param(elem.decl.name, text.slice(x.start, x.end));
            edits.push({ start: c.end, end: x.start, text: `.some(${v} => ${v}.id == ` });
            idOf(e.element);
            rewrites.push({ line: e.at.start.line, from: 'xs.includes(e)', to: `xs.some(${v} => ${v}.id == e.id)` });
        }
    }
    const out: MigratedComparisons[] = [];
    for (const [path, { text, edits, rewrites }] of byFile) {
        if (!edits.length) continue;
        // from the end; at one offset, the edits made later (by inner expressions) go after those made earlier
        const ordered = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.end - a.end || a.i - b.i);
        let next = text;
        for (const e of ordered) next = next.slice(0, e.start) + e.text + next.slice(e.end);
        out.push({ path, text: next, rewrites: rewrites.sort((a, b) => a.line - b.line) });
    }
    return out;
}
