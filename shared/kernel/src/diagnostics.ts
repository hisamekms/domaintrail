// The functions over diagnostics. Their types (`Diagnostic`, `Position`, `Severity`, `JsonDiagnostic`) are the kernel's
// context in model/kernel.dt, generated into ./generated (ADR 0028).
import type { Diagnostic, JsonDiagnostic } from './generated/Kernel.js';

/**
 * The code of a diagnostic: `SYNTAX` for lexer and parser errors, otherwise the ID of the rule that reports it. Each
 * context owns its rule IDs (Modeling's `ModelingRuleId`, Storming's `StormingRuleId`); the kernel knows none of them.
 */
export type RuleCode = Diagnostic['code'];

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
    return diagnostics.some((d) => d.severity === 'error');
}

/** `file:line:col - severity CODE: message`, and the hint on an indented second line. */
export function formatDiagnostic(d: Diagnostic): string {
    const line = `${d.file}:${d.start.line}:${d.start.column} - ${d.severity} ${d.code}: ${d.message}`;
    return d.hint ? `${line}\n  hint: ${d.hint}` : line;
}

/** The diagnostic as written by `dt check --format json` (see schema/diagnostics.schema.json). */
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
