// `dt migrate domain`, after the syntax: every outcome lists the non-optional fields it makes exist (design D). A
// field of the same name as a parameter gets `f = f`; the others a bare `changes f`, whose value the model leaves open.
// Applied to a workspace's analysis, since the fields of an aggregate may come from other files (field sets).
import { AstUtils, CstUtils, isLeafCstNode, type AstNode, type LeafCstNode } from 'langium';
import { missingValues, type MissingValue } from '../../domain/rules/completeness.js';
import type { SourceModel } from '../../domain/source-model.js';
import * as ast from './generated/ast.js';
import type { DomainDocument } from './parse.js';

/** A rewrite of one file, with what it added for the report. */
export interface CompletedChanges {
    readonly path: string;
    readonly text: string;
    readonly added: readonly { readonly line: number; readonly outcome: string; readonly changes: string }[];
}

const ownTokens = (node: AstNode, text: string): LeafCstNode[] =>
    node.$cstNode
        ? CstUtils.streamCst(node.$cstNode)
              .filter((n): n is LeafCstNode => isLeafCstNode(n) && !n.hidden && n.astNode === node && n.text === text)
              .toArray()
        : [];

/** The `changes` entries a list of missing values needs: `f = f` when a parameter of that name exists, else `f`. */
const entries = (missing: readonly MissingValue[]): string => missing.map((m) => (m.param ? `${m.field.name} = ${m.param}` : m.field.name)).join(', ');

export function completeChanges(analysis: {
    readonly documents: readonly DomainDocument[];
    readonly sourceModel?: SourceModel;
    readonly resolveFile: (uri: string) => string;
}): CompletedChanges[] {
    const model = analysis.sourceModel;
    if (!model) return [];
    const out: CompletedChanges[] = [];
    for (const doc of analysis.documents) {
        const text = doc.textDocument.getText();
        const edits: { offset: number; text: string }[] = [];
        const added: CompletedChanges['added'][number][] = [];
        for (const agg of AstUtils.streamAst(doc.parseResult.value).filter(ast.isAggregate)) {
            const ctx = AstUtils.getContainerOfType(agg, ast.isContext);
            const decl = model.elements.find((e) => e.kind === 'aggregate' && e.id === `${ctx?.name}.${agg.name}`);
            if (decl?.kind !== 'aggregate') continue;
            const missing = missingValues(decl);
            /** Adds the entries to `node`'s `changes`, or a `changes` clause before its `emits` / `ensures` / `errors`. */
            const complete = (node: ast.Outcome | ast.Command, list: readonly MissingValue[]): void => {
                if (!list.length || !node.$cstNode) return;
                const clause = entries(list);
                const last = node.changes.at(-1)?.$cstNode;
                if (last) edits.push({ offset: last.end, text: `, ${clause}` });
                else {
                    const next = ['emits', 'ensures', 'errors'].flatMap((k) => ownTokens(node, k)).sort((a, b) => a.offset - b.offset)[0];
                    // a shorthand command ends with its last clause; a named outcome with its target or select
                    if (next) {
                        // a clause that starts its own line gets one of its own, at the same indent
                        const lineStart = text.lastIndexOf('\n', next.offset - 1) + 1;
                        const indent = text.slice(lineStart, next.offset);
                        edits.push({ offset: next.offset, text: /^\s*$/.test(indent) ? `changes ${clause}\n${indent}` : `changes ${clause} ` });
                    } else edits.push({ offset: node.$cstNode.end, text: ` changes ${clause}` });
                }
                added.push({ line: node.$cstNode.range.start.line + 1, outcome: list[0]!.outcome, changes: clause });
            };
            for (const cmd of AstUtils.streamAst(agg).filter(ast.isCommand)) {
                const of = (m: MissingValue) => m.command === cmd.name && !m.kind;
                if (cmd.outcomes.length)
                    for (const o of cmd.outcomes)
                        complete(
                            o,
                            missing.filter((m) => of(m) && m.outcome === o.name),
                        );
                else
                    complete(
                        cmd,
                        missing.filter((m) => of(m) && m.outcome === cmd.name),
                    );
            }
            for (const c of AstUtils.streamAst(agg).filter(ast.isCommandCase)) {
                const kind = AstUtils.getContainerOfType(c, ast.isKind)?.name;
                for (const o of c.outcomes)
                    complete(
                        o,
                        missing.filter((m) => m.command === c.command.$refText && m.kind === kind && m.outcome === o.name),
                    );
            }
        }
        if (!edits.length) continue;
        let next = text;
        for (const e of edits.sort((a, b) => b.offset - a.offset)) next = next.slice(0, e.offset) + e.text + next.slice(e.offset);
        out.push({ path: analysis.resolveFile(doc.uri.toString()), text: next, added });
    }
    return out;
}
