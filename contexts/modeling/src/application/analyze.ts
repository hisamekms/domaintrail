import { buildModel } from '../infrastructure/syntax/build.js';
import { buildSourceModel } from '../infrastructure/syntax/build-source.js';
import type { FileResolver } from '../infrastructure/syntax/site.js';
import type { ModelIndex } from '../infrastructure/syntax/model-index.js';
import { parseDomain, type DomainDocument } from '../infrastructure/syntax/parse.js';
import type { DomainModel } from '../domain/model.js';
import type { SourceModel } from '../domain/source-model.js';
import { RuleSink } from '../domain/diagnostics.js';
import { checkChanges, checkCommands, checkFactoryIds } from '../domain/rules/commands.js';
import { checkEventIds } from '../domain/rules/events.js';
import { checkFieldSets } from '../domain/rules/field-sets.js';
import { checkInvariants } from '../domain/rules/expressions.js';
import { checkLabels } from '../domain/rules/labels.js';
import { checkNames } from '../domain/rules/names.js';
import { checkPayloadNames } from '../domain/rules/payloads.js';
import { checkPolicies } from '../domain/rules/policies.js';
import { checkShared } from '../domain/rules/shared.js';
import { checkStructure } from '../domain/rules/structure.js';
import { checkUnions } from '../domain/rules/unions.js';
import { checkVerified } from '../domain/rules/verified.js';
import { compareDiagnostics, dedupeDiagnostics, type Diagnostic } from '@domaintrail/kernel';
import type { SourceFile } from '@domaintrail/kernel';

/** Modeling's analysis of the `.dt` sources of a workspace: what the project analysis (@domaintrail/analysis) builds on. */
export interface DomainAnalysis {
    /** The `.dt` sources analyzed. */
    files: string[];
    /** The `.dt` documents. */
    documents: DomainDocument[];
    index: ModelIndex;
    /** The diagnostics of the `.dt` sources, sorted: syntax, linking and Modeling's rules. */
    diagnostics: Diagnostic[];
    /** True when every `.dt` file parsed without lexer/parser errors. */
    syntaxOk: boolean;
    /** Typed Model; present whenever the `.dt` sources parse (semantic errors are tolerated). */
    model?: DomainModel;
    /**
     * The model as written, with the sites of every declaration, member, expression and reference: what Modeling's
     * rules and the generator's name check read. Present whenever the `.dt` sources parse.
     */
    sourceModel?: SourceModel;
    /** The path handed in for a document's URI, for the checks that report on the documents afterwards. */
    resolveFile: FileResolver;
}

/**
 * Parses, links and validates a set of `.dt` sources as one workspace with Modeling's rules. The rules of other
 * modules (Storming's, the generated TypeScript names) are run by the project analysis.
 */
export async function analyzeDomain(sources: readonly SourceFile[]): Promise<DomainAnalysis> {
    const { documents, index, diagnostics, syntaxOk, resolveFile } = await parseDomain(sources);

    // Modeling's rules read the model as written and report after the syntax and the links, in this order (the
    // diagnostics keep it where `compareDiagnostics` sees no difference)
    const sourceModel = syntaxOk ? buildSourceModel(index, resolveFile) : undefined;
    if (sourceModel) {
        const rules = new RuleSink(diagnostics);
        checkNames(sourceModel, rules);
        checkShared(sourceModel, rules);
        checkStructure(sourceModel, rules);
        checkUnions(sourceModel, rules);
        checkFieldSets(sourceModel, rules);
        checkVerified(sourceModel, rules);
        checkCommands(sourceModel, rules);
        checkFactoryIds(sourceModel, rules);
        checkChanges(sourceModel, rules);
        checkEventIds(sourceModel, rules);
        checkPayloadNames(sourceModel, rules);
        checkPolicies(sourceModel, rules);
        checkInvariants(sourceModel, rules);
        checkLabels(sourceModel, rules);
    }

    const model = syntaxOk ? buildModel(index, resolveFile) : undefined;
    diagnostics.sort(compareDiagnostics);
    return {
        files: sources.map((s) => s.path),
        documents,
        index,
        diagnostics: dedupeDiagnostics(diagnostics),
        syntaxOk,
        model,
        sourceModel,
        resolveFile,
    };
}
