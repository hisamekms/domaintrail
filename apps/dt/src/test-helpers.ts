// Helpers of Presentation's unit tests: models analyzed from inline sources, through Modeling's entry.
import { analyze, type Analysis } from '@domaintrail/analysis';

/** Analyzes inline sources; keys are file names. */
export function check(files: Record<string, string>): Promise<Analysis> {
    return analyze(Object.entries(files).map(([p, text]) => ({ path: p, text })));
}
