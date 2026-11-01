// The model validator of the snapshots, Collaboration's `ModelValidator` port: the analysis `dt check` makes (`analyze`,
// both DSLs). The app implements it, since a context does not depend on the project analysis (ADR 0027, Project
// analysis and configuration).
import type { ModelValidator } from '@domaintrail/collaboration';
import { analyze } from '@domaintrail/modeling';

export function createModelValidator(): ModelValidator {
    return {
        async validate(sources) {
            const a = await analyze(sources.map((s) => ({ path: s.path, text: s.text })));
            return { diagnostics: a.diagnostics, model: a.model, stormings: a.stormings.stormings, stormingsComplete: a.stormings.syntaxOk };
        },
    };
}
