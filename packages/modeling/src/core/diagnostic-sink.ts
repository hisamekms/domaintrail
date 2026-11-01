import { AstUtils, GrammarUtils, type AstNode, type CstNode } from 'langium';
import type { Diagnostic, Severity } from '../kernel/diagnostics.js';
import type { ModelingRuleId } from '../model/rule-ids.js';
import { elementIdOf } from '../model/ids.js';

/** Converts a Langium document URI back into the path that was handed to the analyzer. */
export type FileResolver = (uri: string) => string;

export class DiagnosticSink {
    readonly items: Diagnostic[] = [];

    constructor(private readonly fileOf: FileResolver) {}

    report(severity: Severity, code: ModelingRuleId, message: string, node: AstNode, property?: string, index?: number, hint?: string): void {
        const cst = selectCst(node, property, index);
        const doc = AstUtils.getDocument(node);
        const range = cst?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        this.items.push({
            file: this.fileOf(doc.uri.toString()),
            start: { line: range.start.line + 1, column: range.start.character + 1 },
            end: { line: range.end.line + 1, column: range.end.character + 1 },
            severity,
            code,
            message,
            ...(hint ? { hint } : {}),
            elementId: elementIdOf(node),
        });
    }

    error(code: ModelingRuleId, message: string, node: AstNode, property?: string, index?: number, hint?: string): void {
        this.report('error', code, message, node, property, index, hint);
    }

    warning(code: ModelingRuleId, message: string, node: AstNode, property?: string, index?: number, hint?: string): void {
        this.report('warning', code, message, node, property, index, hint);
    }
}

function selectCst(node: AstNode, property?: string, index?: number): CstNode | undefined {
    if (property) {
        const picked = GrammarUtils.findNodeForProperty(node.$cstNode, property, index ?? 0);
        if (picked) return picked;
    }
    return node.$cstNode;
}
