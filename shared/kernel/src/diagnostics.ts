export type Severity = 'error' | 'warning';

/**
 * The code of a diagnostic: `SYNTAX` for lexer and parser errors, otherwise the ID of the rule that reports it. Each
 * context owns its rule IDs (Modeling's `ModelingRuleId`, Storming's `StormingRuleId`); the kernel knows none of them.
 */
export type RuleCode = string;

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
    code: RuleCode;
    message: string;
    /** One line on what to change, when the message does not say it (e.g. `did you mean 'OrderConfirmed'?`). */
    hint?: string;
    /** Stable ID of the nearest model element (e.g. `Sales.Order`), when known. */
    elementId?: string;
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
    code: RuleCode;
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

/** The diagnostics without repeats: the first of those at the same place with the same rule and message. */
export function dedupeDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    return items.filter((d) => {
        const key = `${d.file}:${d.start.line}:${d.start.column}:${d.code}:${d.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
