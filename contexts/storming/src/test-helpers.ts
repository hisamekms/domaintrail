// Helpers of Storming's unit tests: the typed model of inline `.dt` sources, from Modeling's analysis (its entry).
import { analyzeDomain, type DomainAnalysis } from '@domaintrail/modeling';

/** Analyzes inline `.dt` sources with Modeling's analysis; keys are file names. */
export function check(files: Record<string, string>): Promise<DomainAnalysis> {
    return analyzeDomain(Object.entries(files).map(([p, text]) => ({ path: p, text })));
}
