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

/** What a migration leaves to a person (or the AI): a removed keyword outside a command, or a file that does not parse. */
export interface MigrationLeft extends MigrationPlace {
    message: string;
}

export interface StormingMigration {
    /** The migrated text (the input itself when nothing was rewritten, or when it does not parse). */
    text: string;
    rewrites: MigrationRewrite[];
    left: MigrationLeft[];
}

let services: ReturnType<typeof createStormingServices>['EventStorming'] | undefined;

/**
 * `dt migrate dtes` (ADR 0032): rewrites the relation keywords of `.dtes` v0.1 mechanically, `actor X` → `by X` and
 * `target X` → `handledBy X` in a command; only the keyword changes, every other character stays. What it cannot
 * rewrite is listed: `actor` or `target` in another kind of element (no relation of the grammar means the same), and
 * a file that does not parse (for instance an ID that is now a keyword: `by`, `handledBy`, `from`). Nothing else is
 * changed: what the new rules report afterwards (S024–S028) are decisions, not rewrites.
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
        return { text, rewrites: [], left: [{ ...at, message: `does not parse, nothing rewritten: ${(lexing ?? parsing)!.message}` }] };
    }
    const rewrites: MigrationRewrite[] = [];
    const left: MigrationLeft[] = [];
    const edits: { leaf: LeafCstNode; to: string }[] = [];
    for (const storming of parsed.value.stormings) {
        for (const el of storming.elements) {
            if (!ast.isEsNode(el)) continue;
            for (const clause of el.clauses) {
                if (!ast.isEsRelationClause(clause) || (clause.keyword !== 'actor' && clause.keyword !== 'target')) continue;
                const keyword: RemovedKeyword = clause.keyword;
                const leaf = clause.$cstNode && CstUtils.streamCst(clause.$cstNode).find((n): n is LeafCstNode => isLeafCstNode(n) && n.text === keyword);
                if (!leaf) continue;
                const place = { line: leaf.range.start.line + 1, column: leaf.range.start.character + 1 };
                const targets = clause.targets.map((t) => t.$refText);
                if (ast.isEsCommand(el)) {
                    edits.push({ leaf, to: REMOVED_KEYWORDS[keyword] });
                    rewrites.push({ ...place, from: keyword, to: REMOVED_KEYWORDS[keyword], element: el.name, targets });
                } else {
                    left.push({
                        ...place,
                        message: `\`${keyword} ${targets.join(', ')}\` in ${kindOf(el)} '${el.name}': only a command's \`${keyword}\` has a replacement (\`${REMOVED_KEYWORDS[keyword]}\`); move the relation into the command it belongs to, or remove it`,
                    });
                }
            }
        }
    }
    let out = text;
    for (const e of edits.sort((a, b) => b.leaf.offset - a.leaf.offset)) out = out.slice(0, e.leaf.offset) + e.to + out.slice(e.leaf.end);
    return { text: out, rewrites, left };
}

function kindOf(el: ast.EsNode): string {
    return el.$type.replace(/^Es/, '').replace('ReadModel', 'read model').toLowerCase();
}
