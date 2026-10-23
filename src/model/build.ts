import { AstUtils, type AstNode } from 'langium';
import {
    isAggregate,
    isEntity,
    isEnumDecl,
    isErrorDecl,
    isEventDecl,
    isFieldSet,
    isIdType,
    isOwnsField,
    isPrimitiveDecl,
    isReferenceField,
    isUnionDecl,
    isValueObject,
    type Command,
    type ContextElement,
    type Invariant,
    type Multiplicity,
    type Parameter,
    type Requirement,
    type State,
    type TypeRef,
} from '../language/generated/ast.js';
import { LabelResolver, docComment } from '../core/labels.js';
import { cardinality } from '../core/types.js';
import {
    commandsOf,
    commonFields,
    discriminatorOf,
    fieldSetsOf,
    fieldsOf,
    includedFields,
    invariantsOf,
    primitiveInvariants,
    statesOf,
    type FieldLike,
    type ModelIndex,
    type WithFieldSets,
} from '../core/model-index.js';
import { commandId, elementId, stateId } from './ids.js';
import type { CommandModel, Described, DomainModel, ElementKind, ElementModel, FieldModel, InvariantModel, Location, RequirementModel, StateModel, TermModel, TypeExpr, VariantModel } from './model.js';

export type FileResolver = (uri: string) => string;

/** Builds the Typed Model. Tolerates unresolved references so that the view can render models with semantic errors. */
export function buildModel(index: ModelIndex, fileOf: FileResolver): DomainModel {
    const elements: Record<string, ElementModel> = {};
    const labels = new LabelResolver(index);
    const field = (f: FieldLike | Parameter): FieldModel => fieldModel(f, labels);
    const loc = (node: AstNode): Location => ({
        file: fileOf(AstUtils.getDocument(node).uri.toString()),
        line: (node.$cstNode?.range.start.line ?? 0) + 1,
        endLine: (node.$cstNode?.range.end.line ?? 0) + 1,
    });

    /** Fields taken from the element's field sets, marked with the field set they come from. */
    const included = (el: WithFieldSets): FieldModel[] =>
        includedFields(el).map(({ field: f, fieldSet }) => ({ ...field(f), fieldSet: elementId(fieldSet.$container.name, fieldSet.name) }));
    const withFieldSets = (el: WithFieldSets): Partial<ElementModel> => {
        const sets = fieldSetsOf(el);
        return sets.length && !isFieldSet(el) ? { fieldSets: sets.map((s) => elementId(s.$container.name, s.name)) } : {};
    };

    for (const el of index.elements) {
        const id = elementId(el.$container.name, el.name);
        if (elements[id]) continue; // duplicate, reported by M002
        const base: ElementModel = {
            id,
            context: el.$container.name,
            name: el.name,
            kind: kindOf(el),
            location: loc(el),
            ...described(el),
            fields: [],
            invariants: [],
        };
        if (isIdType(el) || isPrimitiveDecl(el)) {
            base.base = el.base;
            base.invariants = primitiveInvariants(el).map((i) => ({
                name: i.name,
                ...optional('source', i.expr && sourceText(i.expr)),
                ...optional('label', i.label),
                ...optional('doc', i.node === i.expr ? undefined : docComment(i.node)),
            }));
        } else if (isEnumDecl(el)) {
            base.values = el.values.map((v) => v.name);
            const valueLabels = Object.fromEntries(el.values.filter((v) => v.label).map((v) => [v.name, v.label!]));
            if (Object.keys(valueLabels).length) base.valueLabels = valueLabels;
        } else if (isUnionDecl(el)) {
            base.discriminator = discriminatorOf(el);
            const bound = el.tagType?.ref;
            if (bound) base.tagType = elementId(bound.$container.name, bound.name);
            base.variants = el.variants.map((v): VariantModel => {
                // A variant without a label uses the label of the enum value it stands for.
                const label = v.label ?? bound?.values.find((x) => x.name === v.name)?.label;
                return {
                    name: v.name,
                    ...optional('label', label),
                    ...optional('doc', docComment(v)),
                    fields: fieldsOf(v.members).map(field),
                    invariants: invariantsOf(v.members).map(invariant),
                };
            });
        } else if (isAggregate(el)) {
            Object.assign(base, withFieldSets(el));
            base.fields = [...included(el), ...commonFields(el).map(field)];
            base.invariants = invariantsOf(el.members).map(invariant);
            base.states = statesOf(el).map((s) => state(id, s, loc, field));
            base.commands = commandsOf(el).map((c) => command(id, c, loc, field));
        } else {
            Object.assign(base, withFieldSets(el));
            if (isEventDecl(el) && el.persistent) base.persistent = true;
            base.fields = [...included(el), ...fieldsOf(el.members).map(field)];
            base.invariants = invariantsOf(el.members).map(invariant);
        }
        elements[id] = base;
    }
    const contextLabels: Record<string, string> = {};
    const contextDocs: Record<string, string> = {};
    const terms: Record<string, TermModel[]> = {};
    for (const ctx of index.contextNames) {
        const label = labels.contextLabel(ctx);
        if (label) contextLabels[ctx] = label;
        const doc = labels.contextDoc(ctx);
        if (doc) contextDocs[ctx] = doc;
        terms[ctx] = [...labels.termsOf(ctx).values()].map((t) => ({ name: t.name, label: t.label, ...optional('doc', docComment(t)) }));
    }
    return { contexts: index.contextNames, contextLabels, contextDocs, sharedContexts: index.sharedContexts, terms, elements };
}

/** Label and `///` description of a declaration, omitting absent values. */
function described(node: AstNode & { label?: string }): Described {
    return { ...optional('label', node.label), ...optional('doc', docComment(node)) };
}

const optional = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
    (value ? { [key]: value } : {}) as Partial<Record<K, string>>;

function kindOf(el: ContextElement): ElementKind {
    if (isIdType(el)) return 'id';
    if (isPrimitiveDecl(el)) return 'primitive';
    if (isEnumDecl(el)) return 'enum';
    if (isValueObject(el)) return 'valueObject';
    if (isUnionDecl(el)) return 'union';
    if (isEntity(el)) return 'entity';
    if (isAggregate(el)) return 'aggregate';
    if (isEventDecl(el)) return 'event';
    if (isErrorDecl(el)) return 'error';
    if (isFieldSet(el)) return 'fieldSet';
    throw new Error(`unknown element ${(el as AstNode).$type}`);
}

function typeExpr(ref: TypeRef | undefined): TypeExpr {
    if (ref?.primitive) return { kind: 'primitive', name: ref.primitive };
    const target = ref?.decl?.ref;
    const text = ref?.decl?.$refText ?? '';
    if (!target) return { kind: 'ref', ref: text, text };
    return { kind: 'ref', ref: elementId(target.$container.name, target.name), text, target: kindOf(target) };
}

function multiplicityText(m: Multiplicity | undefined): string {
    if (!m) return '';
    if (m.optional) return '?';
    return `[${m.lower}..${m.unbounded ? '*' : m.upper}]`;
}

/** How many times a multiplicity allows: once without one, `?` at most once. */
function bounds(m: Multiplicity | undefined): { lower: number; upper?: number } {
    if (!m) return { lower: 1, upper: 1 };
    if (m.optional) return { lower: 0, upper: 1 };
    return m.unbounded ? { lower: m.lower ?? 0 } : { lower: m.lower ?? 0, upper: m.upper ?? 0 };
}

function fieldModel(f: FieldLike | Parameter, labels: LabelResolver): FieldModel {
    const out: FieldModel = {
        name: f.name,
        kind: f.$type === 'Parameter' ? 'param' : isOwnsField(f) ? 'owns' : isReferenceField(f) ? 'references' : 'field',
        type: typeExpr(f.type),
        cardinality: cardinality(f.multiplicity),
        multiplicity: multiplicityText(f.multiplicity),
    };
    if (isReferenceField(f)) {
        const t = f.target?.ref;
        out.target = t ? elementId(t.$container.name, t.name) : f.target?.$refText;
    }
    const label = labels.fieldLabel(f);
    if (label) {
        out.label = label.label;
        out.labelSource = label.source;
    }
    const doc = labels.fieldDoc(f);
    if (doc) out.doc = doc;
    return out;
}

function invariant(inv: Invariant): InvariantModel {
    return { name: inv.name, ...optional('source', inv.expr && sourceText(inv.expr)), ...described(inv) };
}

function requirement(r: Requirement, qname: (r: { ref?: ContextElement; $refText: string }) => string): RequirementModel {
    return { name: r.name, ...optional('source', r.expr && sourceText(r.expr)), error: qname(r.error), ...described(r) };
}

const sourceText = (e: AstNode | undefined): string => e?.$cstNode?.text.replace(/\s+/g, ' ').trim() ?? '';

function state(aggId: string, s: State, loc: (n: AstNode) => Location, field: (f: FieldLike) => FieldModel): StateModel {
    return {
        id: stateId(aggId, s.name),
        name: s.name,
        ...described(s),
        fields: fieldsOf(s.members).map(field),
        invariants: invariantsOf(s.members).map(invariant),
        location: loc(s),
    };
}

function command(aggId: string, c: Command, loc: (n: AstNode) => Location, field: (f: Parameter) => FieldModel): CommandModel {
    const qname = (r: { ref?: ContextElement; $refText: string }): string =>
        r.ref ? elementId(r.ref.$container.name, r.ref.name) : r.$refText;
    return {
        id: commandId(aggId, c.name),
        name: c.name,
        ...described(c),
        factory: c.factory,
        params: c.params.map(field),
        transitions: c.transitions.map((t) => ({ from: t.from.map((r) => r.$refText), to: t.to.map((r) => r.$refText) })),
        requires: c.requirements.map((r) => requirement(r, qname)),
        emits: c.emits.map((e) => ({
            event: qname(e.event),
            cardinality: cardinality(e.multiplicity),
            multiplicity: multiplicityText(e.multiplicity),
            ...bounds(e.multiplicity),
            ...(e.when && { when: { from: e.when.from.map((r) => r.$refText), to: e.when.to.map((r) => r.$refText) } }),
        })),
        errors: [...new Set([...c.errors, ...c.requirements.map((r) => r.error)].map(qname))],
        location: loc(c),
    };
}
