import type { RuleSink } from '../diagnostics.js';
import { typeRefsIn, type ElementDecl, type SourceModel } from '../source-model.js';

const ALLOWED = 'domain primitives, enums, value objects, unions, field sets and terms';

/** The kinds of element a shared context may hold. */
const ALLOWED_KINDS: ReadonlySet<ElementDecl['kind']> = new Set(['primitive', 'enum', 'valueObject', 'union', 'fieldSet']);

/**
 * M014: shared contexts (shared kernel).
 *   - every fragment of a context agrees on `shared`
 *   - a shared context holds only value types (domain primitives, enums, value objects, unions), field sets and terms
 *   - a shared context depends only on shared contexts
 *   - a simple name is defined by at most one shared context (error), and shadowing it in a context is a warning
 */
export function checkShared(model: SourceModel, rules: RuleSink): void {
    for (const ctx of model.contexts) {
        const fragments = model.fragments.filter((c) => c.name === ctx);
        if (fragments.some((f) => f.shared) && fragments.some((f) => !f.shared)) {
            for (const f of fragments.filter((x) => !x.shared)) {
                rules.error('M014', `Context '${ctx}' is declared 'shared' in another file; declare every part of it as 'shared context'.`, f.nameAt);
            }
        }
    }

    const shared = new Set(model.sharedContexts);
    const definedIn = new Map<string, ElementDecl>();
    for (const el of model.elements) {
        const ctx = el.context;
        if (!shared.has(ctx)) continue;
        if (!ALLOWED_KINDS.has(el.kind)) {
            rules.error(
                'M014',
                `Shared context '${ctx}' can only contain ${ALLOWED}; found ${KIND_NAMES[el.kind] ?? el.kind} '${el.name}'.`,
                el.nameAt,
                `move '${el.name}' to a context that is not shared`,
            );
        }
        for (const ref of typeRefsIn(el)) {
            const target = ref.decl?.target;
            const targetCtx = target?.context;
            if (target && targetCtx && !shared.has(targetCtx)) {
                const hint = `move '${target.name}' into a shared context, or move '${el.name}' out of '${ctx}'`;
                rules.error('M014', `Shared context '${ctx}' cannot depend on '${targetCtx}.${target.name}' of a non-shared context.`, ref.at, hint);
            }
        }
        const prev = definedIn.get(el.name);
        if (prev && prev.context !== ctx) {
            rules.error(
                'M014',
                `'${el.name}' is defined in shared contexts '${prev.context}' and '${ctx}'; references by simple name would be ambiguous.`,
                el.nameAt,
                `rename one of them, or keep only one`,
            );
        } else if (!prev) {
            definedIn.set(el.name, el);
        }
    }

    for (const el of model.elements) {
        const ctx = el.context;
        const sharedEl = definedIn.get(el.name);
        if (shared.has(ctx) || !sharedEl) continue;
        rules.warning(
            'M014',
            `'${ctx}.${el.name}' hides '${sharedEl.context}.${el.name}' of a shared context inside '${ctx}'.`,
            el.nameAt,
            `rename '${el.name}', or remove it and use the shared one`,
        );
    }
}

/** How the message names the kinds a shared context may not hold. */
const KIND_NAMES: Partial<Record<ElementDecl['kind'], string>> = {
    aggregate: 'aggregate',
    entity: 'entity',
    id: 'ID',
    verified: 'verified type',
    event: 'event',
    error: 'error',
    policy: 'policy',
};
