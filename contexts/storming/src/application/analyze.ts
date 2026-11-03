import type { SourceFile } from '@domaintrail/kernel';
import { compareDiagnostics } from '@domaintrail/kernel';
import type { DomainModel } from '@domaintrail/modeling';
import type { StormingAnalysis } from '../domain/ir.js';
import { linkStormings } from '../domain/link.js';
import { parseStormings } from '../infrastructure/syntax/parse.js';
import { validateStormings } from '../domain/validate.js';

export type { StormingAnalysis } from '../domain/ir.js';

/**
 * Analyzes the `.dtes` sources of a workspace (ADR 0024, T6): parses them, then validates the stormings of the files that
 * parse (S001–S009, S014–S022) and links their `ref`s against the Typed Model of the `.dt` sources (S010–S013; skipped
 * without a model). The diagnostics are sorted like `analyze`'s.
 */
export async function analyzeStormings(sources: readonly SourceFile[], model: DomainModel | undefined): Promise<StormingAnalysis> {
    const parsed = await parseStormings(sources);
    const diagnostics = [...parsed.diagnostics, ...validateStormings(parsed.stormings), ...linkStormings(parsed.stormings, model)];
    diagnostics.sort(compareDiagnostics);
    return { files: sources.map((s) => s.path), stormings: parsed.stormings, diagnostics, syntaxOk: parsed.syntaxOk };
}
