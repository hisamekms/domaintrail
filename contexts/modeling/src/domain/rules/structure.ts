import type { RuleSink } from '../diagnostics.js';
import {
    commandsOf,
    commonFields,
    fieldsOf,
    identityField,
    includedFields,
    lookupVisible,
    statesOf,
    variantFields,
    type AggregateDecl,
    type ElementDecl,
    type EntityDecl,
    type FieldDecl,
    type FieldSetDecl,
    type ParamDecl,
    type SourceModel,
    type TypeDecl,
    type UnionDecl,
    type ValueObjectDecl,
} from '../source-model.js';
import { cardinality, multiplicityText } from '../types.js';

type Owner = AggregateDecl | EntityDecl | ValueObjectDecl | UnionDecl;

/** Fields of an element including state-specific fields of aggregates and the fields of every union variant. */
function allFields(el: Owner): FieldDecl[] {
    if (el.kind === 'aggregate') return [...commonFields(el), ...statesOf(el).flatMap((s) => fieldsOf(s.members))];
    if (el.kind === 'union') return variantFields(el);
    return fieldsOf(el.members);
}

/** The fields a value holds, for its cycles: a value object's include those of its field sets. */
function heldFields(el: Owner): FieldDecl[] {
    return el.kind === 'valueObject' ? [...includedFields(el).map((x) => x.field), ...allFields(el)] : allFields(el);
}

/** The ID type an aggregate is identified by, as written in its `id` field (or the conventional name). */
const idTypeOf = (agg: AggregateDecl): string => identityField(agg)?.type?.decl?.text ?? `${agg.name}Id`;

/** Value types that hold fields: value objects and unions. */
const isValueType = (decl: ElementDecl | undefined): decl is ValueObjectDecl | UnionDecl => decl?.kind === 'valueObject' || decl?.kind === 'union';

/** Entities and value types: what `owns` may hold. */
const isOwnable = (decl: TypeDecl | undefined): decl is EntityDecl | ValueObjectDecl | UnionDecl => decl?.kind === 'entity' || isValueType(decl);

/** How the message of M004 names the kind of a type that `owns` may not hold (the names of the syntax). */
const KIND_NAMES: Record<TypeDecl['kind'], string> = {
    id: 'IdType',
    primitive: 'PrimitiveDecl',
    verified: 'VerifiedDecl',
    enum: 'EnumDecl',
    valueObject: 'ValueObject',
    union: 'UnionDecl',
    entity: 'Entity',
    aggregate: 'Aggregate',
};

/**
 * M003 (unique owning aggregate), M004 (no ownership across aggregate boundaries),
 * M005 (reference ID types), M012 (no ownership cycles), M013 (identity fields).
 */
export function checkStructure(model: SourceModel, rules: RuleSink): void {
    const of = <K extends ElementDecl['kind']>(kind: K): Extract<ElementDecl, { kind: K }>[] =>
        model.elements.filter((e): e is Extract<ElementDecl, { kind: K }> => e.kind === kind);
    const aggregates = of('aggregate');
    const entities = of('entity');
    const owners: Owner[] = [...aggregates, ...entities, ...of('valueObject'), ...of('union')];

    for (const el of owners) {
        for (const f of allFields(el)) checkFieldKind(el, f, rules);
    }
    // a field set's fields are plain (M016); what they may hold is checked like any plain field
    for (const fs of of('fieldSet')) {
        for (const f of fieldsOf(fs.members)) if (f.kind === 'field') checkFieldKind(fs, f, rules);
    }
    checkPayloads(model, aggregates, rules);
    checkIdentity(model, aggregates, entities, rules);
    checkOwningAggregates(aggregates, entities, rules);
    checkCycles(owners, rules);
}

function checkFieldKind(owner: Owner | FieldSetDecl, f: FieldDecl, rules: RuleSink): void {
    const decl = f.type?.decl?.target;
    if (decl?.kind === 'verified') return; // no field holds a verified type (M024)
    if (f.kind === 'references') {
        checkReference(f, rules);
        return;
    }
    if (f.kind === 'owns') {
        if (!isOwnable(decl)) {
            const what = f.type?.primitive ?? (decl ? `${KIND_NAMES[decl.kind]} '${decl.name}'` : undefined);
            if (decl?.kind === 'aggregate') {
                const hint = `write 'references ${f.name}: ${idTypeOf(decl)} -> ${decl.name}' instead`;
                rules.error('M004', `'${owner.name}' cannot own aggregate '${decl.name}'; aggregates are referenced by ID ('references').`, f.typeAt, hint);
            } else if (what) {
                const hint = `drop 'owns' to make '${f.name}' a plain field, or give it an entity, value object or union type`;
                rules.error('M004', `'owns' requires an Entity, Value Object or Union, but '${f.name}' has type ${what}.`, f.typeAt, hint);
            }
            return;
        }
        if (isValueType(owner) && decl.kind === 'entity') {
            const hint = `own '${decl.name}' from its aggregate or another entity, or make '${decl.name}' a value object`;
            rules.error('M004', `${owner.kind === 'union' ? 'Union' : 'Value Object'} '${owner.name}' cannot own entity '${decl.name}'.`, f.typeAt, hint);
        }
        if (decl.context !== owner.context && decl.kind === 'entity') {
            const hint = `declare an entity in '${owner.context}' for it, or reference the aggregate that owns '${decl.name}' by ID`;
            rules.error('M004', `Entity '${decl.context}.${decl.name}' belongs to another context and cannot be owned by '${owner.name}'.`, f.typeAt, hint);
        }
        return;
    }
    // Plain field
    if (decl?.kind === 'entity') {
        rules.error('M004', `Entity '${decl.name}' cannot be embedded as a plain field; declare it with 'owns' inside its aggregate.`, f.typeAt);
    } else if (decl?.kind === 'aggregate') {
        rules.error(
            'M004',
            `Aggregate '${decl.name}' cannot be embedded in '${owner.name}'; use 'references ${f.name}: <Id> -> ${decl.name}'.`,
            f.typeAt,
            `write 'references ${f.name}: ${idTypeOf(decl)} -> ${decl.name}'`,
        );
    }
}

function checkReference(f: FieldDecl, rules: RuleSink): void {
    const decl = f.type?.decl?.target;
    if (f.type?.primitive || (decl && decl.kind !== 'id')) {
        const target = f.aggregate?.target;
        const hint = target ? `change the type to '${idTypeOf(target)}', the ID type of '${target.name}'` : undefined;
        rules.error('M005', `Reference '${f.name}' must be typed with an ID type, not '${f.type?.primitive ?? decl?.name}'.`, f.typeAt, hint);
        return;
    }
    const target = f.aggregate?.target;
    if (!decl || !target) return; // unresolved, reported as M001
    const targetId = identityField(target)?.type?.decl?.target;
    if (targetId && targetId !== decl) {
        const hint = `change the type to '${idTypeOf(target)}', or point '->' at the aggregate that '${decl.name}' identifies`;
        rules.error(
            'M005',
            `Reference '${f.name}' has type '${decl.name}', but aggregate '${target.name}' is identified by '${targetId.name}'.`,
            f.typeAt,
            hint,
        );
    }
}

/** Aggregates are never values; they may appear only as `references` targets. */
function checkPayloads(model: SourceModel, aggregates: readonly AggregateDecl[], rules: RuleSink): void {
    const fields: (FieldDecl | ParamDecl)[] = [
        ...model.elements.flatMap((e) => (e.kind === 'event' ? e.members : [])),
        ...model.elements.flatMap((e) => (e.kind === 'error' ? e.members : [])),
        ...aggregates.flatMap((a) => commandsOf(a).flatMap((c) => c.params)),
    ];
    for (const f of fields) {
        const decl = f.type?.decl?.target;
        if (decl?.kind === 'aggregate') {
            rules.error(
                'M004',
                `Aggregate '${decl.name}' cannot be used as a value; use its ID type instead.`,
                f.typeAt,
                `change the type to '${idTypeOf(decl)}'`,
            );
        }
    }
}

function checkIdentity(model: SourceModel, aggregates: readonly AggregateDecl[], entities: readonly EntityDecl[], rules: RuleSink): void {
    const usedBy = new Map<TypeDecl, AggregateDecl | EntityDecl>();
    for (const el of [...aggregates, ...entities]) {
        const idField = identityField(el);
        const kind = el.kind === 'aggregate' ? 'Aggregate' : 'Entity';
        if (!idField) {
            const idType = lookupVisible(model, el.context, `${el.name}Id`);
            const hint =
                idType?.kind === 'id'
                    ? `add the field 'id: ${el.name}Id'`
                    : `declare 'id ${el.name}Id: UUID' in the context and add the field 'id: ${el.name}Id'`;
            rules.error('M013', `${kind} '${el.name}' must declare an identity field 'id' with an ID type.`, el.nameAt, hint);
            continue;
        }
        const decl = idField.type?.decl?.target;
        if (idField.type?.primitive || (decl && decl.kind !== 'id') || multiplicityText(idField.multiplicity) || idField.kind !== 'field') {
            const hint = `write it as 'id: ${el.name}Id' with an ID type of its own, without 'owns', 'references', '?' or '[..]'`;
            rules.error('M013', `The identity field of ${kind} '${el.name}' must be a single plain field of an ID type.`, idField.typeAt, hint);
            continue;
        }
        if (!decl) continue;
        const prev = usedBy.get(decl);
        if (prev) {
            const hint = `declare 'id ${el.name}Id: ${decl.base ?? 'UUID'}' and use it as the type of 'id' here`;
            rules.error('M013', `ID type '${decl.name}' already identifies '${prev.name}'; each Aggregate/Entity needs its own ID type.`, idField.typeAt, hint);
        } else {
            usedBy.set(decl, el);
        }
    }
}

/** M003: every entity is owned (transitively) by exactly one aggregate. */
function checkOwningAggregates(aggregates: readonly AggregateDecl[], entities: readonly EntityDecl[], rules: RuleSink): void {
    const ownedBy = new Map<EntityDecl, Map<AggregateDecl, FieldDecl[]>>();
    for (const agg of aggregates) {
        const visit = (el: Owner, seen: Set<Owner>): void => {
            if (seen.has(el)) return;
            seen.add(el);
            for (const f of allFields(el)) {
                if (f.kind !== 'owns') continue;
                const decl = f.type?.decl?.target;
                if (decl?.kind === 'entity') {
                    const sites = ownedBy.get(decl) ?? new Map<AggregateDecl, FieldDecl[]>();
                    sites.set(agg, [...(sites.get(agg) ?? []), f]);
                    ownedBy.set(decl, sites);
                }
                if (isOwnable(decl)) visit(decl, seen);
            }
        };
        visit(agg, new Set());
    }
    for (const entity of entities) {
        const sites = ownedBy.get(entity);
        if (!sites || sites.size === 0) {
            const hint = `add 'owns ${entity.name[0].toLowerCase()}${entity.name.slice(1)}: ${entity.name}' to the aggregate it belongs to, or make it a value object or an aggregate`;
            rules.warning('M003', `Entity '${entity.name}' is not owned by any aggregate.`, entity.nameAt, hint);
            continue;
        }
        if (sites.size > 1) {
            const names = [...sites.keys()].map((a) => `'${a.name}'`).join(', ');
            for (const fields of [...sites.values()].slice(1)) {
                for (const f of fields) {
                    const hint = `keep 'owns' in one aggregate; make '${entity.name}' a value object to use it in several`;
                    rules.error('M003', `Entity '${entity.name}' is owned by more than one aggregate (${names}).`, f.typeAt, hint);
                }
            }
        }
    }
}

/**
 * M012: the ownership graph (owns + embedded values) has no cycle through an entity or an aggregate. A cycle of value
 * objects and unions alone is a recursive value type: allowed when each of them has a finite value (the cycle passes
 * through `?`, a list that may be empty, or a union with a variant out of it).
 */
function checkCycles(owners: Owner[], rules: RuleSink): void {
    const finite = finiteValues(owners);
    const state = new Map<Owner, 'visiting' | 'done'>();
    const reported = new Set<FieldDecl>();
    const visit = (el: Owner, path: Owner[]): void => {
        state.set(el, 'visiting');
        for (const f of heldFields(el)) {
            if (f.kind === 'references') continue;
            const decl = f.type?.decl?.target;
            if (!isOwnable(decl)) continue;
            if (state.get(decl) === 'visiting') {
                const chain = [...path, el];
                const members = chain.slice(chain.indexOf(decl));
                const values = members.every(isValueType);
                if ((values && members.every((m) => finite.has(m))) || reported.has(f)) continue;
                reported.add(f);
                const cycle = [...members, decl].map((x) => x.name).join(' -> ');
                if (values) {
                    const hint = `make a field on the cycle optional ('?') or a list that may be empty ('[0..*]'), or give a union a variant out of it`;
                    rules.error('M012', `Recursive value without a finite value: ${cycle}.`, f.typeAt, hint);
                } else {
                    const hint = `break the cycle: remove one of its fields, or make that part an aggregate and refer to it with 'references'`;
                    rules.error('M012', `Ownership cycle: ${cycle}.`, f.typeAt, hint);
                }
            } else if (!state.has(decl)) {
                visit(decl, [...path, el]);
            }
        }
        state.set(el, 'done');
    };
    for (const el of owners) if (!state.has(el)) visit(el, []);
}

/**
 * The value objects and unions that have a finite value: a value object whose required fields (one, or a list of at
 * least one) all have one, a union with a variant whose required fields all have one. Fields of other types have one.
 */
function finiteValues(owners: readonly Owner[]): Set<Owner> {
    const finite = new Set<Owner>();
    const has = (f: FieldDecl): boolean => {
        const decl = f.type?.decl?.target;
        if (f.kind === 'references' || !isValueType(decl)) return true;
        const c = cardinality(f.multiplicity);
        return c === 'optional' || c === 'many' || finite.has(decl);
    };
    const values = owners.filter(isValueType);
    for (let grew = true; grew;) {
        grew = false;
        for (const v of values) {
            if (finite.has(v)) continue;
            const ok = v.kind === 'union' ? v.variants.some((x) => fieldsOf(x.members).every(has)) : heldFields(v).every(has);
            if (ok) {
                finite.add(v);
                grew = true;
            }
        }
    }
    return finite;
}
