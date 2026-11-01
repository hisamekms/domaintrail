// The project analysis (ADR 0027, Project analysis and configuration: the capability `analysis`, inside modeling until
// T8 moves it to capabilities/analysis): the sources by language, Modeling's analysis of the `.dt` sources, Storming's
// of the `.dtes` sources against the model, and the generation's checks, combined into one `Analysis`. `dt check`, the
// language server, the view service, the git baseline and Collaboration's validator use it. Nothing else in the
// package imports it (rule `inner-modules` of test/architecture.test.ts).
import type { LangiumDocument } from 'langium';
import type { Model } from '../language/generated/ast.js';
import { analyzeDomain, type DomainAnalysis } from '../core/analyze.js';
import { checkTsNames } from '../core/checker/tsnames.js';
import { DiagnosticSink } from '../core/diagnostic-sink.js';
import type { ModelIndex } from '../core/model-index.js';
import { compareDiagnostics, dedupeDiagnostics, hasErrors, type Diagnostic } from '../kernel/diagnostics.js';
import type { SourceFile } from '../kernel/source.js';
import type { DomainModel } from '../model/model.js';
import { analyzeStormings, type StormingAnalysis } from '../storming/analyze.js';

/** Whether a source is an Event Storming file (`.dtes`, ADR 0024); every other source is a `.dt` file. */
export function isStormingFile(file: string): boolean {
    return file.endsWith('.dtes');
}

/** The sources by language, each in the order given: the `.dt` sources (Modeling's) and the `.dtes` sources (Storming's). */
function byLanguage(sources: readonly SourceFile[]): { domain: SourceFile[]; storming: SourceFile[] } {
    return { domain: sources.filter((s) => !isStormingFile(s.path)), storming: sources.filter((s) => isStormingFile(s.path)) };
}

export interface Analysis {
    /** Every source analyzed, `.dt` and `.dtes`. */
    files: string[];
    /** The `.dt` documents. */
    documents: LangiumDocument<Model>[];
    index: ModelIndex;
    /** The diagnostics of the `.dt` and the `.dtes` sources, sorted. */
    diagnostics: Diagnostic[];
    /** True when every `.dt` file parsed without lexer/parser errors (a `.dtes` syntax error does not count). */
    syntaxOk: boolean;
    /** True when there are no error-level diagnostics at all, in `.dt` or `.dtes` files. */
    ok: boolean;
    /** Typed Model; present whenever the `.dt` sources parse (semantic errors are tolerated). */
    model?: DomainModel;
    /** The `.dtes` sources (ADR 0024), checked against `model`. */
    stormings: StormingAnalysis;
}

/**
 * Parses, links and validates a set of `.dt` and `.dtes` sources as one workspace. The `.dtes` sources (by extension) are
 * analyzed after the `.dt` ones, against their Typed Model; the generation's checks (M011) run when the `.dt` sources
 * parse.
 */
export async function analyze(allSources: readonly SourceFile[]): Promise<Analysis> {
    const sources = byLanguage(allSources);
    const domain = await analyzeDomain(sources.domain);
    const stormings = await analyzeStormings(sources.storming, domain.model);
    const diagnostics = [...domain.diagnostics, ...generationChecks(domain), ...stormings.diagnostics];
    diagnostics.sort(compareDiagnostics);
    return {
        files: allSources.map((s) => s.path),
        documents: domain.documents,
        index: domain.index,
        diagnostics: dedupeDiagnostics(diagnostics),
        syntaxOk: domain.syntaxOk,
        ok: domain.syntaxOk && !hasErrors(diagnostics),
        model: domain.model,
        stormings,
    };
}

/** The checks of the TypeScript generator over the `.dt` sources (M011, `core/checker/tsnames.ts` until T5). */
function generationChecks(domain: DomainAnalysis): Diagnostic[] {
    if (!domain.syntaxOk) return [];
    const sink = new DiagnosticSink(domain.resolveFile);
    checkTsNames(domain.index, sink);
    return sink.items;
}
