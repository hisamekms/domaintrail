import { isAggregate, isEntity, isVerifiedDecl, type TypeRef, type VerifiedDecl } from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commonFields, fieldsOf, statesOf, type FieldLike, type ModelIndex } from '../model-index.js';

/** The type a verified type stands on in the end, past other verified types, as written (`EmailAddress`). */
export function storedTypeText(v: VerifiedDecl): string {
    const seen = new Set<VerifiedDecl>();
    let base: TypeRef | undefined = v.base;
    for (;;) {
        const decl: unknown = base?.decl?.ref;
        if (!isVerifiedDecl(decl) || seen.has(decl)) break;
        seen.add(decl);
        base = decl.base;
    }
    return base?.primitive ?? base?.decl?.$refText ?? '';
}

/**
 * M024: verified types (ADR 0023).
 *   - a verified type verifies a value type (a primitive, domain primitive, ID, enum, value object, union or another
 *     verified type), not an entity or aggregate; the context of `for` is a value type as well, not a verified type;
 *   - verified types do not verify each other in a cycle;
 *   - a verified type is the evidence of a check at one moment: it types command parameters (and the base of another
 *     verified type) only, never a field of an aggregate, entity, value object, union, field set, event or error.
 */
export function checkVerified(index: ModelIndex, sink: DiagnosticSink): void {
    for (const v of index.verifieds) {
        const base = v.base?.decl?.ref;
        if (isEntity(base) || isAggregate(base)) {
            const what = isEntity(base) ? 'entity' : 'aggregate';
            const id = isAggregate(base) ? ` (its ID type, to verify which ${base.name} is meant)` : '';
            sink.error('M024', `Verified type '${v.name}' must verify a value type, not ${what} '${base.name}'.`, v, 'base', undefined, `verify a value of '${base.name}' instead${id}`);
        }
        const context = v.context?.decl?.ref;
        if (isEntity(context) || isAggregate(context) || isVerifiedDecl(context)) {
            const what = isEntity(context) ? 'entity' : isAggregate(context) ? 'aggregate' : 'verified type';
            const hint = isVerifiedDecl(context) ? `name the base type '${storedTypeText(context)}'` : `name the ID type of '${context.name}'`;
            sink.error('M024', `The context of verified type '${v.name}' must be a value type, not ${what} '${context.name}'.`, v, 'context', undefined, hint);
        }
        const chain = [v];
        for (let next = base; isVerifiedDecl(next); next = next.base?.decl?.ref) {
            if (next === v) {
                const cycle = [...chain, v].map((x) => x.name).join(' -> ');
                sink.error('M024', `Verified types verify each other in a cycle: ${cycle}.`, v, 'base', undefined, `make one of them verify the type that is stored`);
                break;
            }
            if (chain.includes(next)) break; // a cycle further along, reported at its own members
            chain.push(next);
        }
    }

    const fields: FieldLike[] = [
        ...index.aggregates.flatMap((a) => [...commonFields(a), ...statesOf(a).flatMap((s) => fieldsOf(s.members))]),
        ...[...index.entities, ...index.valueObjects, ...index.fieldSets].flatMap((el) => fieldsOf(el.members)),
        ...index.unions.flatMap((u) => u.variants.flatMap((variant) => fieldsOf(variant.members))),
        ...[...index.events, ...index.errors].flatMap((el) => el.members),
    ];
    for (const f of fields) {
        const decl = f.type?.decl?.ref;
        if (!isVerifiedDecl(decl)) continue;
        const stored = storedTypeText(decl);
        sink.error(
            'M024',
            `Verified type '${decl.name}' is the evidence of a check at one moment and types command parameters only; field '${f.name}' cannot hold it.`,
            f,
            'type',
            undefined,
            `store the base type '${stored}'`,
        );
    }
}
