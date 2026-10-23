import { AstUtils, GrammarUtils, type AstNode, type CstNode } from 'langium';
import { elementIdOf } from '../model/ids.js';

export type Severity = 'error' | 'warning';

/**
 * Rule IDs from the spec (M001–M012), plus M013 (identity field), M014 (shared contexts), M015 (unions), M016 (field sets),
 * M017 (events carry the ID of their aggregate), M018 (invariants and requirements without an expression),
 * M019 (parameters named like fields their command's requirements see), L001–L003 (Japanese names) and SYNTAX for lexer/parser errors.
 */
export type RuleId =
    | 'SYNTAX'
    | 'M001' | 'M002' | 'M003' | 'M004' | 'M005' | 'M006'
    | 'M007' | 'M008' | 'M009' | 'M010' | 'M011' | 'M012' | 'M013' | 'M014' | 'M015' | 'M016' | 'M017' | 'M018' | 'M019'
    | 'L001' | 'L002' | 'L003';

export interface Position {
    /** 1-based */
    line: number;
    /** 1-based */
    column: number;
}

export interface Diagnostic {
    /** File path as given to the analyzer (usually relative to the workspace root). */
    file: string;
    start: Position;
    end: Position;
    severity: Severity;
    code: RuleId;
    message: string;
    /** One line on what to change, when the message does not say it (e.g. `did you mean 'OrderConfirmed'?`). */
    hint?: string;
    /** Stable ID of the nearest model element (e.g. `Sales.Order`), when known. */
    elementId?: string;
}

/** Converts a Langium document URI back into the path that was handed to the analyzer. */
export type FileResolver = (uri: string) => string;

export class DiagnosticSink {
    readonly items: Diagnostic[] = [];

    constructor(private readonly fileOf: FileResolver) {}

    report(severity: Severity, code: RuleId, message: string, node: AstNode, property?: string, index?: number, hint?: string): void {
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

    error(code: RuleId, message: string, node: AstNode, property?: string, index?: number, hint?: string): void {
        this.report('error', code, message, node, property, index, hint);
    }

    warning(code: RuleId, message: string, node: AstNode, property?: string, index?: number, hint?: string): void {
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

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
    return diagnostics.some((d) => d.severity === 'error');
}

/** `file:line:col - severity CODE: message`, and the hint on an indented second line. */
export function formatDiagnostic(d: Diagnostic): string {
    const line = `${d.file}:${d.start.line}:${d.start.column} - ${d.severity} ${d.code}: ${d.message}`;
    return d.hint ? `${line}\n  hint: ${d.hint}` : line;
}

/** A diagnostic as written by `dt check --format json` (see schema/diagnostics.schema.json). */
export interface JsonDiagnostic {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: Severity;
    code: RuleId;
    message: string;
    hint?: string;
}

export function jsonDiagnostic(d: Diagnostic): JsonDiagnostic {
    return {
        file: d.file,
        line: d.start.line,
        column: d.start.column,
        endLine: d.end.line,
        endColumn: d.end.column,
        severity: d.severity,
        code: d.code,
        message: d.message,
        ...(d.hint ? { hint: d.hint } : {}),
    };
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
    return a.file.localeCompare(b.file) || a.start.line - b.start.line || a.start.column - b.start.column || a.code.localeCompare(b.code);
}
