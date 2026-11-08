// Japanese (display) names over the model as written (source-model.ts), as the syntax's `LabelResolver` resolves them:
//   declarations          `aggregate Order "注文"` (inline only)
//   fields / parameters   inline label → context `terms` → label of the field's type
//                         (for `references`, the label of the target aggregate)
// A field of the model as written does not know its context, so the functions take it.
import type { FieldDecl, ParamDecl, SourceModel, TermDecl } from './source-model.js';

export type LabelSource = 'inline' | 'term' | 'type';

export interface ResolvedLabel {
    label: string;
    source: LabelSource;
}

/** A term of a context (first definition wins; duplicates are reported by M002). */
export function termOf(model: SourceModel, ctx: string, name: string): TermDecl | undefined {
    for (const f of model.fragments) {
        if (f.name !== ctx) continue;
        const term = f.terms.find((t) => t.name === name);
        if (term) return term;
    }
    return undefined;
}

/** A term as seen from `ctx`: its own terms first, then those of shared contexts. */
export function termFor(model: SourceModel, ctx: string, name: string): TermDecl | undefined {
    return termOf(model, ctx, name) ?? model.sharedContexts.map((s) => termOf(model, s, name)).find(Boolean);
}

/** Label of a context; the first fragment that declares one wins. */
export function contextLabel(model: SourceModel, ctx: string): string | undefined {
    return model.fragments.find((c) => c.name === ctx && c.label)?.label;
}

/** The label of a field or parameter of context `ctx`: inline, from a term, or from its type. */
export function fieldLabel(model: SourceModel, ctx: string, f: FieldDecl | ParamDecl): ResolvedLabel | undefined {
    if (f.label) return { label: f.label, source: 'inline' };
    const term = termFor(model, ctx, f.name);
    if (term) return { label: term.label, source: 'term' };
    const typeLabel = f.kind === 'references' ? f.aggregate?.target?.label : f.type?.decl?.target?.label;
    return typeLabel ? { label: typeLabel, source: 'type' } : undefined;
}
