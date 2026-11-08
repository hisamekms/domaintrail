// The project analysis (ADR 0027, Project analysis and configuration: the capability `analysis`): the sources by
// language, Modeling's analysis of the `.dt` sources, Storming's of the `.dtes` sources against the model, and the
// generation's checks, combined into one `Analysis`. `dt check`, the language server, the view service, the git
// baseline and Collaboration's validator (implemented by the app) use it.
import { compareDiagnostics, dedupeDiagnostics, hasErrors, type Diagnostic, type SourceFile } from '@domaintrail/kernel';
import { analyzeDomain, type DomainAnalysis, type DomainModel } from '@domaintrail/modeling';
import { analyzeStormings, isStormingFile, type StormingAnalysis } from '@domaintrail/storming';
import { checkGeneratedNames } from '@domaintrail/generation';

/** The sources by language, each in the order given: the `.dt` sources (Modeling's) and the `.dtes` sources (Storming's). */
function byLanguage(sources: readonly SourceFile[]): { domain: SourceFile[]; storming: SourceFile[] } {
    return { domain: sources.filter((s) => !isStormingFile(s.path)), storming: sources.filter((s) => isStormingFile(s.path)) };
}

export interface Analysis {
    /** Every source analyzed, `.dt` and `.dtes`. */
    files: string[];
    /** The `.dt` documents. */
    documents: DomainAnalysis['documents'];
    index: DomainAnalysis['index'];
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
    const diagnostics = [...domain.diagnostics, ...checkGeneratedNames(domain), ...stormings.diagnostics];
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
