// The `///` description of a `.dtes` declaration: the same rule as Modeling's for `.dt` (a copy, as the two syntaxes
// share no code).
import { AstUtils, type AstNode } from 'langium';

/** Joins the `///` lines directly above a node (no blank lines in between). */
export function docComment(node: AstNode): string | undefined {
    const cst = node.$cstNode;
    if (!cst) return undefined;
    const text = AstUtils.getDocument(node).textDocument.getText();
    const lines = text.slice(0, cst.offset).split(/\r?\n/);
    // A comment belongs to a node only when the node starts its line, not to a field written after `{`.
    if (lines.pop()!.trim() !== '') return undefined;
    const doc: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^\s*\/\/\/ ?(.*)$/.exec(lines[i]);
        if (!m) break;
        doc.unshift(m[1].trimEnd());
    }
    return doc.length ? doc.join('\n') : undefined;
}
