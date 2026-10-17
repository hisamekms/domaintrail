import { AstUtils, type AstNode } from 'langium';
import { isContext, isReferenceField, type Parameter, type TermEntry } from '../language/generated/ast.js';
import type { FieldLike, ModelIndex } from './model-index.js';

export type LabelSource = 'inline' | 'term' | 'type';

export interface ResolvedLabel {
    label: string;
    source: LabelSource;
}

/**
 * Resolves Japanese (display) names.
 *   declarations          `aggregate Order "注文"` (inline only)
 *   fields / parameters   inline label → context `terms` → label of the field's type
 *                         (for `references`, the label of the target aggregate)
 * Descriptions come from `///` comment lines directly above a declaration or term.
 */
export class LabelResolver {
    private readonly terms = new Map<string, Map<string, TermEntry>>();

    constructor(private readonly index: ModelIndex) {
        for (const ctx of index.fragments) {
            const map = this.terms.get(ctx.name) ?? new Map<string, TermEntry>();
            for (const block of ctx.terms) {
                for (const entry of block.entries) {
                    if (!map.has(entry.name)) map.set(entry.name, entry);
                }
            }
            this.terms.set(ctx.name, map);
        }
    }

    /** Terms of a context (first definition wins; duplicates are reported by M002). */
    termsOf(ctx: string): Map<string, TermEntry> {
        return this.terms.get(ctx) ?? new Map();
    }

    /** A term as seen from `ctx`: its own terms first, then those of shared contexts. */
    termFor(ctx: string, name: string): TermEntry | undefined {
        return this.termsOf(ctx).get(name) ?? this.index.sharedContexts.map((s) => this.termsOf(s).get(name)).find(Boolean);
    }

    /** Label of a context; the first fragment that declares one wins. */
    contextLabel(ctx: string): string | undefined {
        return this.index.fragments.find((c) => c.name === ctx && c.label)?.label;
    }

    fieldLabel(f: FieldLike | Parameter): ResolvedLabel | undefined {
        if (f.label) return { label: f.label, source: 'inline' };
        const ctx = AstUtils.getContainerOfType(f, isContext)?.name;
        const term = ctx ? this.termFor(ctx, f.name) : undefined;
        if (term) return { label: term.label, source: 'term' };
        const typeLabel = isReferenceField(f) ? f.target?.ref?.label : f.type?.decl?.ref?.label;
        return typeLabel ? { label: typeLabel, source: 'type' } : undefined;
    }

    /** Description of a field: its own `///` comment, or the one of its term. */
    fieldDoc(f: FieldLike | Parameter): string | undefined {
        const own = docComment(f);
        if (own) return own;
        const ctx = AstUtils.getContainerOfType(f, isContext)?.name;
        const term = ctx ? this.termFor(ctx, f.name) : undefined;
        return term ? docComment(term) : undefined;
    }
}

/** Joins the `///` lines directly above a node (no blank lines in between). */
export function docComment(node: AstNode): string | undefined {
    const cst = node.$cstNode;
    if (!cst) return undefined;
    const text = AstUtils.getDocument(node).textDocument.getText();
    const lines = text.slice(0, cst.offset).split(/\r?\n/);
    // A comment belongs to a node only when the node starts its line, not to a field written after `{`.
    if (lines.pop()!.trim() !== '') return undefined;
    const doc: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^\s*\/\/\/ ?(.*)$/.exec(lines[i]);
        if (!m) break;
        doc.unshift(m[1].trimEnd());
    }
    return doc.length ? doc.join('\n') : undefined;
}
