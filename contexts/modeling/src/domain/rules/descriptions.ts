import type { RuleSink } from '../diagnostics.js';
import type { Site, SourceModel } from '../source-model.js';

/**
 * M025: a context's description (`///` above `context X`) is written once, across all the files of the context.
 * The first by file name (by code point, the order `dt check` reads the sources in, so the one the Typed Model keeps) is
 * kept; each later one is an error that names it. Sorting here keeps the result the same whatever the order of the input.
 */
export function checkDescriptions(model: SourceModel, rules: RuleSink): void {
    for (const ctx of model.contexts) {
        const described = model.fragments.filter((c) => c.name === ctx && c.docAt).sort((a, b) => compareSites(a.docAt!, b.docAt!));
        const kept = described[0]?.docAt;
        if (!kept) continue;
        const where = `${kept.file}:${kept.start.line}`;
        for (const f of described.slice(1)) {
            rules.error(
                'M025',
                `Context '${ctx}' already has a description at ${where}.`,
                f.docAt!,
                `merge this description into the one at ${where}, and remove it here`,
            );
        }
    }
}

/** By file (code point), then line. */
function compareSites(a: Site, b: Site): number {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.start.line - b.start.line;
}
