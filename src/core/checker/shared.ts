import { AstUtils, type AstNode } from 'langium';
import { isContext, isEnumDecl, isFieldSet, isPrimitiveDecl, isTypeRef, isUnionDecl, isValueObject, type ContextElement } from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import type { ModelIndex } from '../model-index.js';

const ALLOWED = 'domain primitives, enums, value objects, unions, field sets and terms';

/**
 * M014: shared contexts (shared kernel).
 *   - every fragment of a context agrees on `shared`
 *   - a shared context holds only value types (domain primitives, enums, value objects, unions), field sets and terms
 *   - a shared context depends only on shared contexts
 *   - a simple name is defined by at most one shared context (error), and shadowing it in a context is a warning
 */
export function checkShared(index: ModelIndex, sink: DiagnosticSink): void {
    for (const ctx of index.contextNames) {
        const fragments = index.fragments.filter((c) => c.name === ctx);
        if (fragments.some((f) => f.shared) && fragments.some((f) => !f.shared)) {
            for (const f of fragments.filter((x) => !x.shared)) {
                sink.error('M014', `Context '${ctx}' is declared 'shared' in another file; declare every part of it as 'shared context'.`, f, 'name');
            }
        }
    }

    const shared = new Set(index.sharedContexts);
    const definedIn = new Map<string, ContextElement>();
    for (const el of index.elements) {
        const ctx = el.$container.name;
        if (!shared.has(ctx)) continue;
        if (!isPrimitiveDecl(el) && !isEnumDecl(el) && !isValueObject(el) && !isUnionDecl(el) && !isFieldSet(el)) {
            sink.error('M014', `Shared context '${ctx}' can only contain ${ALLOWED}; found ${kind(el)} '${el.name}'.`, el, 'name', undefined, `move '${el.name}' to a context that is not shared`);
        }
        for (const ref of AstUtils.streamAllContents(el).filter(isTypeRef)) {
            const target = ref.decl?.ref;
            const targetCtx = target && AstUtils.getContainerOfType(target, isContext)?.name;
            if (targetCtx && !shared.has(targetCtx)) {
                const hint = `move '${target.name}' into a shared context, or move '${el.name}' out of '${ctx}'`;
                sink.error('M014', `Shared context '${ctx}' cannot depend on '${targetCtx}.${target.name}' of a non-shared context.`, ref, undefined, undefined, hint);
            }
        }
        const prev = definedIn.get(el.name);
        if (prev && prev.$container.name !== ctx) {
            sink.error('M014', `'${el.name}' is defined in shared contexts '${prev.$container.name}' and '${ctx}'; references by simple name would be ambiguous.`, el, 'name', undefined, `rename one of them, or keep only one`);
        } else if (!prev) {
            definedIn.set(el.name, el);
        }
    }

    for (const el of index.elements) {
        const ctx = el.$container.name;
        const sharedEl = definedIn.get(el.name);
        if (shared.has(ctx) || !sharedEl) continue;
        sink.warning(
            'M014',
            `'${ctx}.${el.name}' hides '${sharedEl.$container.name}.${el.name}' of a shared context inside '${ctx}'.`,
            el,
            'name',
            undefined,
            `rename '${el.name}', or remove it and use the shared one`,
        );
    }
}

function kind(el: AstNode): string {
    const names: Record<string, string> = { Aggregate: 'aggregate', Entity: 'entity', IdType: 'ID', VerifiedDecl: 'verified type', EventDecl: 'event', ErrorDecl: 'error', Policy: 'policy' };
    return names[el.$type] ?? el.$type;
}
