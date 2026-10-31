import type { SourceFile } from '../core/analyze.js';
import { compareDiagnostics } from '../core/diagnostics.js';
import type { DomainModel } from '../model/model.js';
import type { StormingAnalysis } from './ir.js';
import { linkStormings } from './link.js';
import { parseStormings } from './parse.js';
import { validateStormings } from './validate.js';

export type { StormingAnalysis } from './ir.js';

/**
 * Analyzes the `.dtes` sources of a workspace (ADR 0024, T6): parses them, then validates the stormings of the files that
 * parse (S001–S009, S014) and links their `ref`s against the Typed Model of the `.dt` sources (S010–S013; skipped
 * without a model). The diagnostics are sorted like `analyze`'s.
 */
export async function analyzeStormings(sources: readonly SourceFile[], model: DomainModel | undefined): Promise<StormingAnalysis> {
    const parsed = await parseStormings(sources);
    const diagnostics = [...parsed.diagnostics, ...validateStormings(parsed.stormings), ...linkStormings(parsed.stormings, model)];
    diagnostics.sort(compareDiagnostics);
    return { files: sources.map((s) => s.path), stormings: parsed.stormings, diagnostics, syntaxOk: parsed.syntaxOk };
}
