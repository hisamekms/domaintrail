import { CstUtils, isLeafCstNode, type LeafCstNode } from 'langium';
import * as ast from './generated/ast.js';
import { createStormingServices } from './module.js';
import { REMOVED_KEYWORDS, type RemovedKeyword } from '../../domain/ir.js';

/** Where a migration changed, or could not change, a file: 1-based like a diagnostic. */
export interface MigrationPlace {
    line: number;
    column: number;
}

/** A keyword rewritten: `actor X` → `by X` or `target X` → `handledBy X` in a command. */
export interface MigrationRewrite extends MigrationPlace {
    from: RemovedKeyword;
    to: string;
    /** The command's ID and the clause's targets, for the report. */
    element: string;
    targets: string[];
}

/**
 * A `reads` moved from a command a policy issues into that policy (ADR 0032 §9), at the place of the clause in the
 * command (in the input).
 */
export interface MigrationMove extends MigrationPlace {
    command: string;
    policy: string;
    /** The read models the clause names. */
    targets: string[];
}

/**
 * What a migration leaves to a person (or the AI): a removed keyword outside a command, a file that does not parse, a
 * `reads` of a command several policies issue, a policy issuing several commands.
 */
export interface MigrationLeft extends MigrationPlace {
    message: string;
}

export interface StormingMigration {
    /** The migrated text (the input itself when nothing was rewritten, or when it does not parse). */
    text: string;
    rewrites: MigrationRewrite[];
    moves: MigrationMove[];
    left: MigrationLeft[];
}

let services: ReturnType<typeof createStormingServices>['EventStorming'] | undefined;

/** A splice of the input: `[from, to)` replaced by `text`. */
interface Edit {
    from: number;
    to: number;
    text: string;
}

/**
 * `dt migrate dtes` (ADR 0032): rewrites `.dtes` files of earlier versions mechanically, changing only what it must and
 * keeping comments and layout.
 *
 * - v0.1 (§5): `actor X` → `by X` and `target X` → `handledBy X` in a command; only the keyword changes. `actor` or
 *   `target` in another kind of element has no replacement and is listed.
 * - 0.8 (§9): the `reads` of a command a policy issues (without `by`) moves into that policy, after its `on` clauses
 *   (where `dt fmt` puts it), with the comments on its lines, when exactly one policy issues the command. When several
 *   do, it is listed (which of them looks at it is a decision, not a copy); so is a policy issuing several commands
 *   (no name for the policies it splits into can be made up), whose commands keep their `reads`.
 *
 * A file that does not parse (for instance an ID that is now a keyword: `by`, `handledBy`, `from`) is listed and left
 * as it is. A second run changes nothing. What the rules report afterwards (S024–S031) are decisions, not rewrites.
 */
export function migrateStorming(text: string): StormingMigration {
    services ??= createStormingServices().EventStorming;
    const parsed = services.parser.LangiumParser.parse<ast.EsFile>(text);
    const lexing = parsed.lexerErrors[0];
    const parsing = parsed.parserErrors[0];
    if (lexing || parsing) {
        const at = lexing
            ? { line: lexing.line ?? 1, column: lexing.column ?? 1 }
            : { line: parsing!.token.startLine ?? 1, column: parsing!.token.startColumn ?? 1 };
        return { text, rewrites: [], moves: [], left: [{ ...at, message: `does not parse, nothing rewritten: ${(lexing ?? parsing)!.message}` }] };
    }
    const rewrites: MigrationRewrite[] = [];
    const moves: MigrationMove[] = [];
    const left: MigrationLeft[] = [];
    const edits: Edit[] = [];
    const comments = services.parser.Lexer.tokenize(text).hidden.map((t) => ({ offset: t.startOffset, end: t.startOffset + t.image.length }));
    for (const storming of parsed.value.stormings) {
        for (const el of storming.elements) {
            if (!ast.isEsNode(el)) continue;
            for (const clause of el.clauses) {
                if (!ast.isEsRelationClause(clause) || (clause.keyword !== 'actor' && clause.keyword !== 'target')) continue;
                const keyword: RemovedKeyword = clause.keyword;
                const leaf = keywordLeaf(clause);
                if (!leaf) continue;
                const place = placeOf(leaf);
                const targets = clause.targets.map((t) => t.$refText);
                if (ast.isEsCommand(el)) {
                    edits.push({ from: leaf.offset, to: leaf.end, text: REMOVED_KEYWORDS[keyword] });
                    rewrites.push({ ...place, from: keyword, to: REMOVED_KEYWORDS[keyword], element: el.name, targets });
                } else {
                    left.push({
                        ...place,
                        message: `\`${keyword} ${targets.join(', ')}\` in ${kindOf(el)} '${el.name}': only a command's \`${keyword}\` has a replacement (\`${REMOVED_KEYWORDS[keyword]}\`); move the relation into the command it belongs to, or remove it`,
                    });
                }
            }
        }
        moveReads(text, storming, comments, edits, moves, left);
    }
    let out = text;
    for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
    return { text: out, rewrites, moves, left: left.sort((a, b) => a.line - b.line || a.column - b.column) };
}

/** The keyword token of a relation clause. */
const keywordLeaf = (clause: ast.EsRelationClause): LeafCstNode | undefined =>
    clause.$cstNode && CstUtils.streamCst(clause.$cstNode).find((n): n is LeafCstNode => isLeafCstNode(n) && n.text === clause.keyword);

const placeOf = (leaf: LeafCstNode): MigrationPlace => ({ line: leaf.range.start.line + 1, column: leaf.range.start.character + 1 });

const relations = (el: ast.EsNode, keyword: string): ast.EsRelationClause[] =>
    el.clauses.filter((c): c is ast.EsRelationClause => ast.isEsRelationClause(c) && c.keyword === keyword);

const quoted = (names: readonly string[]): string =>
    names.length < 2
        ? `'${names[0]}'`
        : `${names
              .slice(0, -1)
              .map((n) => `'${n}'`)
              .join(', ')} and '${names.at(-1)}'`;

/**
 * ADR 0032 §9: the `reads` of each command one policy issues (without `by`) into that policy, as edits; what it cannot
 * move, listed.
 */
function moveReads(
    text: string,
    storming: ast.EsStorming,
    comments: readonly { offset: number; end: number }[],
    edits: Edit[],
    moves: MigrationMove[],
    left: MigrationLeft[],
): void {
    const commands = new Map<string, ast.EsCommand>();
    for (const el of storming.elements) if (ast.isEsCommand(el) && !commands.has(el.name)) commands.set(el.name, el);
    /** The commands each policy issues (declared as commands, each once), and the policies issuing each command. */
    const issued = new Map<ast.EsPolicy, string[]>();
    const issuers = new Map<string, ast.EsPolicy[]>();
    for (const el of storming.elements) {
        if (!ast.isEsPolicy(el)) continue;
        const names = [...new Set(relations(el, 'issues').flatMap((c) => c.targets.map((t) => t.$refText)))].filter((n) => commands.has(n));
        issued.set(el, names);
        for (const n of names) if (!issuers.get(n)?.includes(el)) issuers.set(n, [...(issuers.get(n) ?? []), el]);
        if (names.length < 2) continue;
        left.push({
            ...placeOf(keywordLeaf(relations(el, 'issues')[0]!)!),
            message: `policy '${el.name}' issues ${quoted(names)}: a policy issues one command (S031); split it into one policy per command, each with the \`reads\` it looks at, then run this again (the \`reads\` of its commands are left where they are)`,
        });
    }
    /** The `reads` clauses moving into each policy, in source order. */
    const into = new Map<ast.EsPolicy, { clause: ast.EsRelationClause; targets: string[] }[]>();
    for (const command of commands.values()) {
        const reads = relations(command, 'reads');
        const policies = issuers.get(command.name) ?? [];
        // with `by` (or `actor`), the command is the person's (S025 tells to remove `by`): nothing moves
        if (!reads.length || !policies.length || relations(command, 'by').length || relations(command, 'actor').length) continue;
        for (const clause of reads) {
            const targets = clause.targets.map((t) => t.$refText);
            const place = placeOf(keywordLeaf(clause)!);
            const what = `\`reads ${targets.join(', ')}\` in command '${command.name}'`;
            if (policies.length > 1) {
                left.push({
                    ...place,
                    message: `${what}, which the policies ${quoted(policies.map((p) => p.name))} issue: write it in the \`reads\` of the policy that looks at it, and remove it here (S030); it is not copied to each`,
                });
                continue;
            }
            const policy = policies[0]!;
            if (issued.get(policy)!.length > 1) {
                left.push({
                    ...place,
                    message: `${what} not moved: policy '${policy.name}', which issues it, issues several commands (S031); split the policy first, then run this again`,
                });
                continue;
            }
            into.set(policy, [...(into.get(policy) ?? []), { clause, targets }]);
            moves.push({ ...place, command: command.name, policy: policy.name, targets });
        }
    }
    for (const [policy, moved] of into) {
        const already = new Set(relations(policy, 'reads').flatMap((c) => c.targets.map((t) => t.$refText)));
        const chunks: string[][] = [];
        for (const { clause, targets } of moved) {
            const { from, to, lines } = cut(text, clause, comments);
            edits.push({ from, to, text: '' });
            const fresh = targets.filter((t) => !already.has(t));
            for (const t of fresh) already.add(t);
            if (!fresh.length) continue;
            // the clause as written, or only the read models the policy does not read yet
            chunks.push(fresh.length === targets.length ? lines : lines.map((l) => (l.trimStart().startsWith('reads ') ? `reads ${fresh.join(', ')}` : l)));
        }
        if (chunks.length) edits.push(insertion(text, policy, chunks.flat(), comments));
    }
}

/**
 * The span of a clause to remove from its body, and its lines without their indentation: on a line of its own, the
 * whole line with the comment after it and the comments on the lines right above it (after the token before them);
 * inline, the clause and the spaces after it.
 */
function cut(text: string, clause: ast.EsRelationClause, comments: readonly { offset: number; end: number }[]): { from: number; to: number; lines: string[] } {
    const cst = clause.$cstNode!;
    const lineStart = text.lastIndexOf('\n', cst.offset - 1) + 1;
    let end = cst.end;
    const after = comments.find((k) => k.offset >= end && /^[ \t]*$/.test(text.slice(end, k.offset)));
    if (after) end = after.end;
    const rest = /^[ \t]*(\r?\n|$)/.exec(text.slice(end));
    if (!/^[ \t]*$/.test(text.slice(lineStart, cst.offset)) || !rest) {
        const spaces = /^[ \t]*/.exec(text.slice(cst.end))![0].length;
        return { from: cst.offset, to: cst.end + spaces, lines: [cst.text] };
    }
    const from = commentsAbove(text, lineStart, comments);
    const to = end + rest[0].length;
    const lines = text
        .slice(from, end)
        .split(/\r?\n/)
        .map((l) => l.trim());
    return { from, to, lines };
}

/**
 * Where the moved lines go in a policy: before its first clause that comes after `reads` in `dt fmt`'s order (its
 * `issues`, which it has since it issues the command), above that clause's own comments, in its indentation. In a body
 * written on one line, the clauses only, inline.
 */
function insertion(text: string, policy: ast.EsPolicy, lines: string[], comments: readonly { offset: number; end: number }[]): Edit {
    const anchor = policy.clauses.find((c) => !ast.isEsRefClause(c) && !(ast.isEsRelationClause(c) && (c.keyword === 'on' || c.keyword === 'reads')))!;
    const cst = anchor.$cstNode!;
    const lineStart = text.lastIndexOf('\n', cst.offset - 1) + 1;
    if (!/^[ \t]*$/.test(text.slice(lineStart, cst.offset))) {
        const clauses = lines.filter((l) => !l.startsWith('//') && !l.startsWith('/*'));
        return { from: cst.offset, to: cst.offset, text: `${clauses.join(' ')} ` };
    }
    const indent = text.slice(lineStart, cst.offset);
    // above the comments on lines of their own right above the anchor, which are the anchor's
    const at = commentsAbove(text, lineStart, comments);
    return { from: at, to: at, text: lines.map((l) => `${indent}${l}\n`).join('') };
}

/** The start of the lines right above `lineStart` that hold only a comment (`lineStart` itself when there is none). */
function commentsAbove(text: string, lineStart: number, comments: readonly { offset: number; end: number }[]): number {
    let at = lineStart;
    while (at > 0) {
        const above = text.lastIndexOf('\n', at - 2) + 1;
        const own = comments.some(
            (k) => k.offset >= above && k.end <= at - 1 && /^[ \t]*$/.test(text.slice(above, k.offset)) && /^[ \t\r]*$/.test(text.slice(k.end, at - 1)),
        );
        if (!own) break;
        at = above;
    }
    return at;
}

function kindOf(el: ast.EsNode): string {
    return el.$type.replace(/^Es/, '').replace('ReadModel', 'read model').toLowerCase();
}
