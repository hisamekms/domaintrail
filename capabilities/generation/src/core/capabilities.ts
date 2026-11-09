import type { Diagnostic } from '@domaintrail/kernel';
import type { DomainModel } from '@domaintrail/modeling';
import { portableRegexPattern } from './checks.js';

/** Checks target-specific expression support before any generated file is written. */
export function targetCapabilityDiagnostics(model: DomainModel, target: 'ts'): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (target !== 'ts') return diagnostics;
    for (const el of model.elements) {
        const at = { line: el.location.line, column: 1 };
        const report = (message: string): void => {
            diagnostics.push({
                file: el.location.file,
                start: at,
                end: at,
                severity: 'error',
                code: 'G001',
                message,
                elementId: el.id,
            });
        };
        const walk = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) {
                value.forEach(walk);
                return;
            }
            const node: Record<string, unknown> = Object.fromEntries(Object.entries(value));
            if (node.k === 'matches' && typeof node.pattern === 'string') {
                const pattern = node.pattern;
                if (/\(\?|\\(?:[1-9bBpPkK])/.test(pattern)) {
                    report(`The regex '${pattern}' uses a construct outside DomainTrail's portable regex subset.`);
                } else {
                    try {
                        new RegExp(portableRegexPattern(pattern), 'u');
                    } catch {
                        report(`The regex '${pattern}' cannot be reproduced by the TypeScript target.`);
                    }
                }
            }
            for (const child of Object.values(node)) walk(child);
        };
        // The typed model contains expression trees only inside model elements. Walking the element also covers
        // choice rules added to commands and transition groups without coupling this check to a generator's shape.
        walk(el);
    }
    return diagnostics;
}
