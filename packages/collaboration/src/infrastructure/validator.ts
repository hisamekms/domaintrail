// The model validator of the snapshots: the analysis `dt check` makes (`analyze`, both DSLs).
import { analyze } from '@domaintrail/modeling/core/analyze';
import type { ModelValidator } from '../application/ports.js';

export function createModelValidator(): ModelValidator {
    return {
        async validate(sources) {
            const a = await analyze(sources.map((s) => ({ path: s.path, text: s.text })));
            return { diagnostics: a.diagnostics, model: a.model, stormings: a.stormings.stormings, stormingsComplete: a.stormings.syntaxOk };
        },
    };
}
