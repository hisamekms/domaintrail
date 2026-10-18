import {
    isAggregate,
    isEntity,
    isFieldSet,
    isIdType,
    isOwnsField,
    isReferenceField,
    isUnionDecl,
    isValueObject,
    type Aggregate,
    type Entity,
    type FieldSet,
    type OwnsField,
    type UnionDecl,
    type ValueObject,
} from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, commonFields, fieldsOf, identityField, statesOf, variantFields, type FieldLike, type ModelIndex } from '../model-index.js';

type Owner = Aggregate | Entity | ValueObject | UnionDecl;

/** Fields of an element including state-specific fields of aggregates and the fields of every union variant. */
function allFields(el: Owner): FieldLike[] {
    if (isAggregate(el)) return [...commonFields(el), ...statesOf(el).flatMap((s) => fieldsOf(s.members))];
    if (isUnionDecl(el)) return variantFields(el);
    return fieldsOf(el.members);
}

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
    if (isReferenceField(f)) {
        checkReference(f, sink);
        return;
    }
    if (isOwnsField(f)) {
        if (!decl || (!isEntity(decl) && !isValueType(decl))) {
            const what = f.type?.primitive ?? (decl ? `${decl.$type} '${decl.name}'` : undefined);
            if (decl && isAggregate(decl)) {
                sink.error('M004', `'${owner.name}' cannot own aggregate '${decl.name}'; aggregates are referenced by ID ('references').`, f, 'type');
            } else if (what) {
                sink.error('M004', `'owns' requires an Entity, Value Object or Union, but '${f.name}' has type ${what}.`, f, 'type');
            }
            return;
        }
        if (isValueType(owner) && isEntity(decl)) {
            sink.error('M004', `${isUnionDecl(owner) ? 'Union' : 'Value Object'} '${owner.name}' cannot own entity '${decl.name}'.`, f, 'type');
        }
        if (decl.$container.name !== owner.$container.name && isEntity(decl)) {
            sink.error('M004', `Entity '${decl.$container.name}.${decl.name}' belongs to another context and cannot be owned by '${owner.name}'.`, f, 'type');
        }
        return;
    }
    // Plain field
    if (decl && isEntity(decl)) {
        sink.error('M004', `Entity '${decl.name}' cannot be embedded as a plain field; declare it with 'owns' inside its aggregate.`, f, 'type');
    } else if (decl && isAggregate(decl)) {
        sink.error('M004', `Aggregate '${decl.name}' cannot be embedded in '${owner.name}'; use 'references ${f.name}: <Id> -> ${decl.name}'.`, f, 'type');
    }
}

function checkReference(f: FieldLike & { $type: 'ReferenceField' }, sink: DiagnosticSink): void {
    const decl = f.type?.decl?.ref;
    const target = f.target?.ref;
    if (f.type?.primitive || (decl && !isIdType(decl))) {
        sink.error('M005', `Reference '${f.name}' must be typed with an ID type, not '${f.type.primitive ?? decl?.name}'.`, f, 'type');
        return;
    }
    if (!decl || !target) return; // unresolved, reported as M001
    const targetId = identityField(target)?.type?.decl?.ref;
    if (targetId && targetId !== decl) {
        sink.error('M005', `Reference '${f.name}' has type '${decl.name}', but aggregate '${target.name}' is identified by '${targetId.name}'.`, f, 'type');
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
            sink.error('M004', `Aggregate '${decl.name}' cannot be used as a value; use its ID type instead.`, f, 'type');
        }
    }
}

function checkIdentity(index: ModelIndex, sink: DiagnosticSink): void {
    const usedBy = new Map<unknown, Aggregate | Entity>();
    for (const el of [...index.aggregates, ...index.entities]) {
        const idField = identityField(el);
        const kind = isAggregate(el) ? 'Aggregate' : 'Entity';
        if (!idField) {
            sink.error('M013', `${kind} '${el.name}' must declare an identity field 'id' with an ID type.`, el, 'name');
            continue;
        }
        const decl = idField.type?.decl?.ref;
        if (idField.type?.primitive || (decl && !isIdType(decl)) || idField.multiplicity || idField.$type !== 'Field') {
            sink.error('M013', `The identity field of ${kind} '${el.name}' must be a single plain field of an ID type.`, idField, 'type');
            continue;
        }
        if (!decl) continue;
        const prev = usedBy.get(decl);
        if (prev) {
            sink.error('M013', `ID type '${decl.name}' already identifies '${prev.name}'; each Aggregate/Entity needs its own ID type.`, idField, 'type');
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
            sink.warning('M003', `Entity '${entity.name}' is not owned by any aggregate.`, entity, 'name');
            continue;
        }
        if (sites.size > 1) {
            const names = [...sites.keys()].map((a) => `'${a.name}'`).join(', ');
            for (const fields of [...sites.values()].slice(1)) {
                for (const f of fields) {
                    sink.error('M003', `Entity '${entity.name}' is owned by more than one aggregate (${names}).`, f, 'type');
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
                    sink.error('M012', `Ownership cycle: ${cycle}.`, f, 'type');
                }
            } else if (!state.has(decl)) {
                visit(decl, [...path, el]);
            }
        }
        state.set(el, 'done');
    };
    for (const el of owners) if (!state.has(el)) visit(el, []);
}
