import {
    isAggregate,
    isEntity,
    isFieldSet,
    isIdType,
    isOwnsField,
    isReferenceField,
    isUnionDecl,
    isValueObject,
    isVerifiedDecl,
    type Aggregate,
    type Entity,
    type FieldSet,
    type OwnsField,
    type UnionDecl,
    type ValueObject,
} from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, commonFields, fieldsOf, identityField, statesOf, variantFields, type FieldLike, type ModelIndex } from '../model-index.js';
import { multiplicityText } from '../types.js';

type Owner = Aggregate | Entity | ValueObject | UnionDecl;

/** Fields of an element including state-specific fields of aggregates and the fields of every union variant. */
function allFields(el: Owner): FieldLike[] {
    if (isAggregate(el)) return [...commonFields(el), ...statesOf(el).flatMap((s) => fieldsOf(s.members))];
    if (isUnionDecl(el)) return variantFields(el);
    return fieldsOf(el.members);
}

/** The ID type an aggregate is identified by, as written in its `id` field (or the conventional name). */
const idTypeOf = (agg: Aggregate): string => identityField(agg)?.type?.decl?.$refText ?? `${agg.name}Id`;

/** Value types that hold fields: value objects and unions. */
const isValueType = (decl: unknown): decl is ValueObject | UnionDecl => isValueObject(decl) || isUnionDecl(decl);

/**
 * M003 (unique owning aggregate), M004 (no ownership across aggregate boundaries),
 * M005 (reference ID types), M012 (no ownership cycles), M013 (identity fields).
 */
export function checkStructure(index: ModelIndex, sink: DiagnosticSink): void {
    const owners: Owner[] = [...index.aggregates, ...index.entities, ...index.valueObjects, ...index.unions];

    for (const el of owners) {
        for (const f of allFields(el)) checkFieldKind(el, f, sink);
    }
    // a field set's fields are plain (M016); what they may hold is checked like any plain field
    for (const fs of index.fieldSets) {
        for (const f of fieldsOf(fs.members)) if (f.$type === 'Field') checkFieldKind(fs, f, sink);
    }
    checkPayloads(index, sink);
    checkIdentity(index, sink);
    checkOwningAggregates(index, sink);
    checkCycles(owners, sink);
}

function checkFieldKind(owner: Owner | FieldSet, f: FieldLike, sink: DiagnosticSink): void {
    const decl = f.type?.decl?.ref;
    if (isVerifiedDecl(decl)) return; // no field holds a verified type (M024)
    if (isReferenceField(f)) {
        checkReference(f, sink);
        return;
    }
    if (isOwnsField(f)) {
        if (!decl || (!isEntity(decl) && !isValueType(decl))) {
            const what = f.type?.primitive ?? (decl ? `${decl.$type} '${decl.name}'` : undefined);
            if (decl && isAggregate(decl)) {
                const hint = `write 'references ${f.name}: ${idTypeOf(decl)} -> ${decl.name}' instead`;
                sink.error('M004', `'${owner.name}' cannot own aggregate '${decl.name}'; aggregates are referenced by ID ('references').`, f, 'type', undefined, hint);
            } else if (what) {
                const hint = `drop 'owns' to make '${f.name}' a plain field, or give it an entity, value object or union type`;
                sink.error('M004', `'owns' requires an Entity, Value Object or Union, but '${f.name}' has type ${what}.`, f, 'type', undefined, hint);
            }
            return;
        }
        if (isValueType(owner) && isEntity(decl)) {
            const hint = `own '${decl.name}' from its aggregate or another entity, or make '${decl.name}' a value object`;
            sink.error('M004', `${isUnionDecl(owner) ? 'Union' : 'Value Object'} '${owner.name}' cannot own entity '${decl.name}'.`, f, 'type', undefined, hint);
        }
        if (decl.$container.name !== owner.$container.name && isEntity(decl)) {
            const hint = `declare an entity in '${owner.$container.name}' for it, or reference the aggregate that owns '${decl.name}' by ID`;
            sink.error('M004', `Entity '${decl.$container.name}.${decl.name}' belongs to another context and cannot be owned by '${owner.name}'.`, f, 'type', undefined, hint);
        }
        return;
    }
    // Plain field
    if (decl && isEntity(decl)) {
        sink.error('M004', `Entity '${decl.name}' cannot be embedded as a plain field; declare it with 'owns' inside its aggregate.`, f, 'type');
    } else if (decl && isAggregate(decl)) {
        sink.error('M004', `Aggregate '${decl.name}' cannot be embedded in '${owner.name}'; use 'references ${f.name}: <Id> -> ${decl.name}'.`, f, 'type', undefined, `write 'references ${f.name}: ${idTypeOf(decl)} -> ${decl.name}'`);
    }
}

function checkReference(f: FieldLike & { $type: 'ReferenceField' }, sink: DiagnosticSink): void {
    const decl = f.type?.decl?.ref;
    if (f.type?.primitive || (decl && !isIdType(decl))) {
        const target = f.target?.ref;
        const hint = target ? `change the type to '${idTypeOf(target)}', the ID type of '${target.name}'` : undefined;
        sink.error('M005', `Reference '${f.name}' must be typed with an ID type, not '${f.type.primitive ?? decl?.name}'.`, f, 'type', undefined, hint);
        return;
    }
    const target = f.target?.ref;
    if (!decl || !target) return; // unresolved, reported as M001
    const targetId = identityField(target)?.type?.decl?.ref;
    if (targetId && targetId !== decl) {
        const hint = `change the type to '${idTypeOf(target)}', or point '->' at the aggregate that '${decl.name}' identifies`;
        sink.error('M005', `Reference '${f.name}' has type '${decl.name}', but aggregate '${target.name}' is identified by '${targetId.name}'.`, f, 'type', undefined, hint);
    }
}

/** Aggregates are never values; they may appear only as `references` targets. */
function checkPayloads(index: ModelIndex, sink: DiagnosticSink): void {
    const fields = [
        ...index.events.flatMap((e) => e.members),
        ...index.errors.flatMap((e) => e.members),
        ...index.aggregates.flatMap((a) => commandsOf(a).flatMap((c) => c.params)),
    ];
    for (const f of fields) {
        const decl = f.type?.decl?.ref;
        if (decl && isAggregate(decl)) {
            sink.error('M004', `Aggregate '${decl.name}' cannot be used as a value; use its ID type instead.`, f, 'type', undefined, `change the type to '${idTypeOf(decl)}'`);
        }
    }
}

function checkIdentity(index: ModelIndex, sink: DiagnosticSink): void {
    const usedBy = new Map<unknown, Aggregate | Entity>();
    for (const el of [...index.aggregates, ...index.entities]) {
        const idField = identityField(el);
        const kind = isAggregate(el) ? 'Aggregate' : 'Entity';
        if (!idField) {
            const idType = index.lookupVisible(el.$container.name, `${el.name}Id`);
            const hint = idType && isIdType(idType) ? `add the field 'id: ${el.name}Id'` : `declare 'id ${el.name}Id: UUID' in the context and add the field 'id: ${el.name}Id'`;
            sink.error('M013', `${kind} '${el.name}' must declare an identity field 'id' with an ID type.`, el, 'name', undefined, hint);
            continue;
        }
        const decl = idField.type?.decl?.ref;
        if (idField.type?.primitive || (decl && !isIdType(decl)) || multiplicityText(idField.multiplicity) || idField.$type !== 'Field') {
            const hint = `write it as 'id: ${el.name}Id' with an ID type of its own, without 'owns', 'references', '?' or '[..]'`;
            sink.error('M013', `The identity field of ${kind} '${el.name}' must be a single plain field of an ID type.`, idField, 'type', undefined, hint);
            continue;
        }
        if (!decl) continue;
        const prev = usedBy.get(decl);
        if (prev) {
            const hint = `declare 'id ${el.name}Id: ${decl.base ?? 'UUID'}' and use it as the type of 'id' here`;
            sink.error('M013', `ID type '${decl.name}' already identifies '${prev.name}'; each Aggregate/Entity needs its own ID type.`, idField, 'type', undefined, hint);
        } else {
            usedBy.set(decl, el);
        }
    }
}

/** M003: every entity is owned (transitively) by exactly one aggregate. */
function checkOwningAggregates(index: ModelIndex, sink: DiagnosticSink): void {
    const ownedBy = new Map<Entity, Map<Aggregate, OwnsField[]>>();
    for (const agg of index.aggregates) {
        const visit = (el: Owner, seen: Set<Owner>): void => {
            if (seen.has(el)) return;
            seen.add(el);
            for (const f of allFields(el)) {
                if (!isOwnsField(f)) continue;
                const decl = f.type?.decl?.ref;
                if (isEntity(decl)) {
                    const sites = ownedBy.get(decl) ?? new Map<Aggregate, OwnsField[]>();
                    sites.set(agg, [...(sites.get(agg) ?? []), f]);
                    ownedBy.set(decl, sites);
                }
                if (isEntity(decl) || isValueType(decl)) visit(decl, seen);
            }
        };
        visit(agg, new Set());
    }
    for (const entity of index.entities) {
        const sites = ownedBy.get(entity);
        if (!sites || sites.size === 0) {
            const hint = `add 'owns ${entity.name[0].toLowerCase()}${entity.name.slice(1)}: ${entity.name}' to the aggregate it belongs to, or make it a value object or an aggregate`;
            sink.warning('M003', `Entity '${entity.name}' is not owned by any aggregate.`, entity, 'name', undefined, hint);
            continue;
        }
        if (sites.size > 1) {
            const names = [...sites.keys()].map((a) => `'${a.name}'`).join(', ');
            for (const fields of [...sites.values()].slice(1)) {
                for (const f of fields) {
                    const hint = `keep 'owns' in one aggregate; make '${entity.name}' a value object to use it in several`;
                    sink.error('M003', `Entity '${entity.name}' is owned by more than one aggregate (${names}).`, f, 'type', undefined, hint);
                }
            }
        }
    }
}

/** M012: the ownership graph (owns + embedded value objects) is acyclic. */
function checkCycles(owners: Owner[], sink: DiagnosticSink): void {
    const state = new Map<Owner, 'visiting' | 'done'>();
    const reported = new Set<FieldLike>();
    const visit = (el: Owner, path: Owner[]): void => {
        state.set(el, 'visiting');
        for (const f of allFields(el)) {
            if (isReferenceField(f)) continue;
            const decl = f.type?.decl?.ref;
            if (!isEntity(decl) && !isValueType(decl)) continue;
            if (state.get(decl) === 'visiting') {
                if (!reported.has(f)) {
                    reported.add(f);
                    const chain = [...path, el];
                    const cycle = [...chain.slice(chain.indexOf(decl)), decl].map((x) => x.name).join(' -> ');
                    const hint = `break the cycle: remove one of its fields, or make that part an aggregate and refer to it with 'references'`;
                    sink.error('M012', `Ownership cycle: ${cycle}.`, f, 'type', undefined, hint);
                }
            } else if (!state.has(decl)) {
                visit(decl, [...path, el]);
            }
        }
        state.set(el, 'done');
    };
    for (const el of owners) if (!state.has(el)) visit(el, []);
}
