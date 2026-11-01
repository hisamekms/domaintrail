// The site of an AST node: where a diagnostic on it goes. The model as written (build-source.ts) carries one for every
// declaration, member, expression and reference, and Modeling's rules report at them through `RuleSink`
// (domain/diagnostics.ts).
import { AstUtils, GrammarUtils, type AstNode, type CstNode } from 'langium';
import type { Site } from '../../domain/source-model.js';
import { elementIdOf } from './element-id.js';

/** Converts a Langium document URI back into the path that was handed to the analyzer. */
export type FileResolver = (uri: string) => string;

/**
 * Where a diagnostic on `node` goes (at `property`, its `index`th value; the whole node without one, or when the node
 * has no such value): the range and the stable ID of the model element it lies in.
 */
export function siteOf(node: AstNode, fileOf: FileResolver, property?: string, index?: number): Site {
    const cst = selectCst(node, property, index);
    const range = cst?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return {
        file: fileOf(AstUtils.getDocument(node).uri.toString()),
        start: { line: range.start.line + 1, column: range.start.character + 1 },
        end: { line: range.end.line + 1, column: range.end.character + 1 },
        elementId: elementIdOf(node),
    };
}

function selectCst(node: AstNode, property?: string, index?: number): CstNode | undefined {
    if (property) {
        const picked = GrammarUtils.findNodeForProperty(node.$cstNode, property, index ?? 0);
        if (picked) return picked;
    }
    return node.$cstNode;
}
