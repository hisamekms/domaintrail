import type { RuleSink } from '../diagnostics.js';
import { commonFields, fieldsOf, statesOf, type ElementDecl, type FieldDecl, type SourceModel, type TypeRef, type VerifiedDecl } from '../source-model.js';

/** The type a verified type stands on in the end, past other verified types, as written (`EmailAddress`). */
export function storedTypeText(v: VerifiedDecl): string {
    const seen = new Set<VerifiedDecl>();
    let base: TypeRef | undefined = v.base;
    for (;;) {
        const decl = base?.decl?.target;
        if (decl?.kind !== 'verified' || seen.has(decl)) break;
        seen.add(decl);
        base = decl.base;
    }
    return base?.primitive ?? base?.decl?.text ?? '';
}

/**
 * M024: verified types (ADR 0023).
 *   - a verified type verifies a value type (a primitive, domain primitive, ID, enum, value object, union or another
 *     verified type), not an entity or aggregate; the context of `for` is a value type as well, not a verified type;
 *   - verified types do not verify each other in a cycle;
 *   - a verified type is the evidence of a check at one moment: it types command parameters (and the base of another
 *     verified type) only, never a field of an aggregate, entity, value object, union, field set, event or error.
 */
export function checkVerified(model: SourceModel, rules: RuleSink): void {
    for (const v of model.elements) {
        if (v.kind !== 'verified') continue;
        const base = v.base?.decl?.target;
        if (base?.kind === 'entity' || base?.kind === 'aggregate') {
            const what = base.kind === 'entity' ? 'entity' : 'aggregate';
            const id = base.kind === 'aggregate' ? ` (its ID type, to verify which ${base.name} is meant)` : '';
            rules.error(
                'M024',
                `Verified type '${v.name}' must verify a value type, not ${what} '${base.name}'.`,
                v.baseAt,
                `verify a value of '${base.name}' instead${id}`,
            );
        }
        const context = v.for?.decl?.target;
        if (context?.kind === 'entity' || context?.kind === 'aggregate' || context?.kind === 'verified') {
            const what = context.kind === 'entity' ? 'entity' : context.kind === 'aggregate' ? 'aggregate' : 'verified type';
            const hint = context.kind === 'verified' ? `name the base type '${storedTypeText(context)}'` : `name the ID type of '${context.name}'`;
            rules.error('M024', `The context of verified type '${v.name}' must be a value type, not ${what} '${context.name}'.`, v.forAt, hint);
        }
        const chain = [v];
        for (let next = base; next?.kind === 'verified'; next = next.base?.decl?.target) {
            if (next === v) {
                const cycle = [...chain, v].map((x) => x.name).join(' -> ');
                rules.error('M024', `Verified types verify each other in a cycle: ${cycle}.`, v.baseAt, `make one of them verify the type that is stored`);
                break;
            }
            if (chain.includes(next)) break; // a cycle further along, reported at its own members
            chain.push(next);
        }
    }

    // grouped by kind, in the order of the syntax's index
    const of = <K extends ElementDecl['kind']>(kind: K): Extract<ElementDecl, { kind: K }>[] =>
        model.elements.filter((el): el is Extract<ElementDecl, { kind: K }> => el.kind === kind);
    const fields: FieldDecl[] = [
        ...of('aggregate').flatMap((a) => [...commonFields(a), ...statesOf(a).flatMap((s) => fieldsOf(s.members))]),
        ...[...of('entity'), ...of('valueObject'), ...of('fieldSet')].flatMap((el) => fieldsOf(el.members)),
        ...of('union').flatMap((u) => u.variants.flatMap((variant) => fieldsOf(variant.members))),
        ...[...of('event'), ...of('error')].flatMap((el) => el.members),
    ];
    for (const f of fields) {
        const decl = f.type?.decl?.target;
        if (decl?.kind !== 'verified') continue;
        const stored = storedTypeText(decl);
        rules.error(
            'M024',
            `Verified type '${decl.name}' is the evidence of a check at one moment and types command parameters only; field '${f.name}' cannot hold it.`,
            f.typeAt,
            `store the base type '${stored}'`,
        );
    }
}
