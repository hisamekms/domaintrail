// The model validator of the snapshots, Collaboration's `ModelValidator` port: the analysis `dt check` makes (`analyze`,
// both DSLs). The app implements it, since a context does not depend on the project analysis (ADR 0027, Project
// analysis and configuration). And its `SourceFormatter`: the printers of `dt fmt`, for what a mechanical revert writes;
// its `StickyEditor`: Storming's planner of people's edits of the stickies (ADR 0033).
import type { ModelValidator, SourceFormatter, StickyEditor } from '@domaintrail/collaboration';
import { analyze } from '@domaintrail/analysis';
import { formatDomain } from '@domaintrail/modeling';
import { formatStorming, isStormingFile, planStickyEdit, stickyWording } from '@domaintrail/storming';

export function createModelValidator(): ModelValidator {
    return {
        async validate(sources) {
            const a = await analyze(sources.map((s) => ({ path: s.path, text: s.text })));
            return { diagnostics: a.diagnostics, model: a.model, stormings: a.stormings.stormings, stormingsComplete: a.stormings.syntaxOk };
        },
    };
}

/** Formats a source that parses as `dt fmt` does: a `.dtes` with Storming's printer, any other with Modeling's. */
export function createSourceFormatter(): SourceFormatter {
    return { format: (path, text) => (isStormingFile(path) ? formatStorming(text) : formatDomain(text)) };
}

/** People's edits of the stickies, planned on the parsed `.dtes` (only the tokens concerned change). */
export function createStickyEditor(): StickyEditor {
    return { plan: planStickyEdit, wording: stickyWording };
}
