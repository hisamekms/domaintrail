import { AstUtils, type AstNode } from 'langium';
import type { Location } from '@domaintrail/kernel';
import {
    isAggregate,
    isInitial,
    isTransitionGroup,
    isCommandCase,
    isBinaryExpr,
    isBoolLiteral,
    isContainsExpr,
    isCountExpr,
    isDecimalLiteral,
    isEntity,
    isExistsExpr,
    isIntLiteral,
    isLengthExpr,
    isMatchesExpr,
    isMemberAccess,
    isNameRef,
    isNotExpr,
    isQuantifierExpr,
    isRangeExpr,
    isStringLiteral,
    isUniqueExpr,
    isEnumDecl,
    isErrorDecl,
    isEventDecl,
    isFieldSet,
    isIdType,
    isInvariant,
    isOwnsField,
    isPolicy,
    isPrimitiveDecl,
    isReferenceField,
    isUnionDecl,
    isValueObject,
    isVerifiedDecl,
    type Command,
    type Outcome,
    type TransitionGroup,
    type ContextElement,
    type Expression,
    type Invariant,
    type Multiplicity,
    type Parameter,
    type Requirement,
    type State,
    type TypeRef,
} from './generated/ast.js';
import { LabelResolver, docComment } from './labels.js';
import { expressionText } from './format.js';
import { cardinality, multiplicityText } from '../../domain/types.js';
import type { FileResolver } from './site.js';
import { regexSource } from './regex-source.js';
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
} from './model-index.js';
import { commandId, contextName, elementId, qualifiedName, stateId } from '../../domain/ids.js';
import type {
    BinaryOp,
    CommandModel,
    ContextModel,
    ElementId,
    Described,
    DomainModel,
    ElementKind,
    ElementModel,
    ExprModel,
    FieldModel,
    InvariantModel,
    QualifiedName,
    RequirementModel,
    StateModel,
    TypeExpr,
    VariantModel,
} from '../../domain/model.js';

/** Builds the Typed Model. Tolerates unresolved references so that the view can render models with semantic errors. */
export function buildModel(index: ModelIndex, fileOf: FileResolver): DomainModel {
    const elements = new Map<string, ElementModel>();
    const labels = new LabelResolver(index);
    const field = (f: FieldLike | Parameter): FieldModel => fieldModel(f, labels);
    const loc = (node: AstNode): Location => ({
        file: fileOf(AstUtils.getDocument(node).uri.toString()),
        line: (node.$cstNode?.range.start.line ?? 0) + 1,
        endLine: (node.$cstNode?.range.end.line ?? 0) + 1,
    });

    /** Fields taken from the element's field sets, marked with the field set they come from. */
    const included = (el: WithFieldSets): FieldModel[] => includedFields(el).map(({ field: f, fieldSet }) => ({ ...field(f), fieldSet: qname(fieldSet) }));
    const fieldSets = (el: WithFieldSets): QualifiedName[] => fieldSetsOf(el).map(qname);

    for (const el of index.elements) {
        const id = elementId(el.$container.name, el.name);
        if (elements.has(id)) continue; // duplicate, reported by M002
        const head = { id, context: contextName(el.$container.name), name: el.name };
        const common = { location: loc(el), ...described(el) };
        elements.set(id, element(el));

        function element(el: ContextElement): ElementModel {
            if (isIdType(el) || isPrimitiveDecl(el)) {
                const invariants = primitiveInvariants(el).map((i): InvariantModel => ({
                    name: i.name,
                    ...optional('source', i.expr && sourceText(i.expr)),
                    ...(i.expr && { expr: exprModel(i.expr) }),
                    ...(isInvariant(i.node) && i.node.external && { externalReason: i.node.external.reason }),
                    ...optional('label', i.label),
                    ...optional('doc', i.node === i.expr ? undefined : docComment(i.node)),
                }));
                return { ...head, kind: isIdType(el) ? 'id' : 'primitive', ...common, base: el.base, invariants };
            }
            if (isVerifiedDecl(el)) {
                const verified = {
                    of: typeExpr(el.base),
                    ...(el.context && { for: { type: typeExpr(el.context), optional: el.contextOptional } }),
                    errors: [...new Set(el.errors.map(refName))],
                };
                return { ...head, kind: 'verified', ...common, verified };
            }
            if (isEnumDecl(el)) return { ...head, kind: 'enum', ...common, values: el.values.map((v) => ({ name: v.name, ...optional('label', v.label) })) };
            if (isUnionDecl(el)) {
                const bound = el.tagType?.ref;
                const variants = el.variants.map((v): VariantModel => {
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
                return {
                    ...head,
                    kind: 'union',
                    ...common,
                    discriminator: discriminatorOf(el),
                    ...(bound && { tagType: qname(bound) }),
                    variants,
                };
            }
            if (isAggregate(el)) {
                return {
                    ...head,
                    kind: 'aggregate',
                    ...common,
                    fieldSets: fieldSets(el),
                    fields: [...included(el), ...commonFields(el).map(field)],
                    invariants: invariantsOf(el.members).map(invariant),
                    states: statesOf(el).map((s) => state(id, s, loc, field)),
                    commands: commandsOf(el).map((c) => command(id, c, loc, field)),
                    initials: el.members.filter(isInitial).map((i) => ({ state: i.state.$refText, kinds: [] })),
                    groups: el.members.filter(isTransitionGroup).map(group),
                    ...lifecycleOf(el),
                    validStates: validStatesOf(el),
                };
            }
            if (isPolicy(el)) {
                return {
                    ...head,
                    kind: 'policy',
                    ...common,
                    policy: { event: refName(el.event), aggregate: refName(el.aggregate), command: el.command.$refText },
                };
            }
            if (isFieldSet(el)) return { ...head, kind: 'fieldSet', ...common, fields: fieldsOf(el.members).map(field) };
            const fields = [...included(el), ...fieldsOf(el.members).map(field)];
            if (isEventDecl(el)) return { ...head, kind: 'event', ...common, fieldSets: fieldSets(el), fields, persistent: el.persistent };
            if (isErrorDecl(el)) return { ...head, kind: 'error', ...common, fieldSets: fieldSets(el), fields };
            const invariants = invariantsOf(el.members).map(invariant);
            return { ...head, kind: isEntity(el) ? 'entity' : 'valueObject', ...common, fieldSets: fieldSets(el), fields, invariants };
        }
    }
    const contexts = index.contextNames.map((ctx): ContextModel => ({
        name: contextName(ctx),
        ...optional('label', labels.contextLabel(ctx)),
        ...optional('doc', labels.contextDoc(ctx)),
        shared: index.sharedContexts.includes(ctx),
        terms: [...labels.termsOf(ctx).values()].map((t) => ({ name: t.name, label: t.label, ...optional('doc', docComment(t)) })),
    }));
    return { contexts, elements: [...elements.values()] };
}

/** The qualified name of a declaration of a context. */
const qname = (decl: { name: string; $container: { name: string } }): QualifiedName => qualifiedName(`${decl.$container.name}.${decl.name}`);

/** A reference by qualified name: the target's, or as written when it does not resolve. */
const refName = (r: { ref?: ContextElement; $refText: string }): QualifiedName => (r.ref ? qname(r.ref) : qualifiedName(r.$refText));

/** Label and `///` description of a declaration, omitting absent values. */
function described(node: AstNode & { label?: string }): Described {
    return { ...optional('label', node.label), ...optional('doc', docComment(node)) };
}

const optional = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a computed key is typed as a string index
    (value ? { [key]: value } : {}) as Partial<Record<K, string>>;

function kindOf(el: ContextElement): ElementKind {
    if (isIdType(el)) return 'id';
    if (isPrimitiveDecl(el)) return 'primitive';
    if (isVerifiedDecl(el)) return 'verified';
    if (isEnumDecl(el)) return 'enum';
    if (isValueObject(el)) return 'valueObject';
    if (isUnionDecl(el)) return 'union';
    if (isEntity(el)) return 'entity';
    if (isAggregate(el)) return 'aggregate';
    if (isEventDecl(el)) return 'event';
    if (isErrorDecl(el)) return 'error';
    if (isFieldSet(el)) return 'fieldSet';
    if (isPolicy(el)) return 'policy';
    throw new Error(`unknown element ${(el as AstNode).$type}`);
}

function typeExpr(ref: TypeRef | undefined): TypeExpr {
    if (ref?.primitive) return { kind: 'primitive', name: ref.primitive };
    const target = ref?.decl?.ref;
    const text = ref?.decl?.$refText ?? '';
    if (!target) return { kind: 'ref', ref: qualifiedName(text), text };
    return { kind: 'ref', ref: qname(target), text, target: kindOf(target) };
}

/** How many times a multiplicity allows: once without one, `?` at most once. */
function bounds(m: Multiplicity | undefined): { lower: number; upper?: number } {
    if (!m) return { lower: 1, upper: 1 };
    if (m.optional) return { lower: 0, upper: 1 };
    return m.unbounded ? { lower: m.lower ?? 0 } : { lower: m.lower ?? 0, upper: m.upper ?? 0 };
}

function fieldModel(f: FieldLike | Parameter, labels: LabelResolver): FieldModel {
    const t = isReferenceField(f) ? f.target : undefined;
    const target = t?.ref ? qname(t.ref) : t?.$refText !== undefined ? qualifiedName(t.$refText) : undefined;
    const label = labels.fieldLabel(f);
    const doc = labels.fieldDoc(f);
    return {
        name: f.name,
        kind: f.$type === 'Parameter' ? 'param' : isOwnsField(f) ? 'owns' : isReferenceField(f) ? 'references' : 'field',
        type: typeExpr(f.type),
        cardinality: cardinality(f.multiplicity),
        multiplicity: multiplicityText(f.multiplicity),
        ...(target !== undefined && { target }),
        ...(label && { label: label.label, labelSource: label.source }),
        ...(doc && { doc }),
        readonly: 'readonly' in f && f.readonly === true,
    };
}

function invariant(inv: Invariant): InvariantModel {
    return {
        name: inv.name,
        ...optional('source', inv.expr && sourceText(inv.expr)),
        ...(inv.expr && { expr: exprModel(inv.expr) }),
        ...optional('externalReason', inv.external?.reason),
        ...described(inv),
    };
}

function requirement(r: Requirement): RequirementModel {
    return {
        name: r.name,
        ...optional('source', r.expr && sourceText(r.expr)),
        ...(r.expr && { expr: exprModel(r.expr) }),
        error: refName(r.error),
        ...optional('externalReason', r.external?.reason),
        ...described(r),
    };
}

/** The operators as the grammar writes them, as the model names them. */
const BINARY_OPS: Readonly<Record<string, BinaryOp>> = {
    implies: 'implies',
    or: 'or',
    and: 'and',
    '==': 'eq',
    '!=': 'ne',
    '<': 'lt',
    '<=': 'le',
    '>': 'gt',
    '>=': 'ge',
};

/** The tree of an expression (syntax only; the model has no errors when it is read for generated checks). */
function exprModel(e: Expression): ExprModel {
    if (isBoolLiteral(e)) return { k: 'bool', value: e.value === 'true' };
    if (isIntLiteral(e)) return { k: 'int', value: e.negative ? -e.value : e.value };
    if (isDecimalLiteral(e)) return { k: 'decimal', value: `${e.negative ? '-' : ''}${e.value}` };
    if (isStringLiteral(e)) return { k: 'string', value: e.value };
    if (isNameRef(e)) return { k: 'name', name: e.name };
    if (isMemberAccess(e)) return { k: 'member', receiver: exprModel(e.receiver), member: e.member };
    if (isNotExpr(e)) return { k: 'not', operand: exprModel(e.operand) };
    if (isBinaryExpr(e)) return { k: 'binary', op: BINARY_OPS[e.op], left: exprModel(e.left), right: exprModel(e.right) };
    if (isRangeExpr(e)) return { k: 'range', operand: exprModel(e.operand), lower: exprModel(e.lower), upper: exprModel(e.upper) };
    if (isCountExpr(e)) return { k: 'count', collection: exprModel(e.collection) };
    if (isExistsExpr(e)) return { k: 'exists', operand: exprModel(e.operand) };
    if (isLengthExpr(e)) return { k: 'length', operand: exprModel(e.operand) };
    if (isMatchesExpr(e)) return { k: 'matches', operand: exprModel(e.operand), pattern: regexSource(e) };
    if (isUniqueExpr(e)) return { k: 'unique', collection: exprModel(e.collection), ...(e.param && { param: e.param.name }), keys: e.keys.map(exprModel) };
    if (isContainsExpr(e)) return { k: 'contains', collection: exprModel(e.collection), element: exprModel(e.element) };
    if (isQuantifierExpr(e))
        return { k: 'quantifier', quantifier: e.quantifier, collection: exprModel(e.collection), param: e.param.name, body: exprModel(e.body) };
    return { k: 'bool', value: false }; // unreachable for a parsed expression
}

const sourceText = (e: AstNode | undefined): string => (e ? expressionText(e) : '');

function state(aggId: ElementId, s: State, loc: (n: AstNode) => Location, field: (f: FieldLike) => FieldModel): StateModel {
    return {
        id: stateId(aggId, s.name),
        name: s.name,
        ...described(s),
        fields: fieldsOf(s.members).map(field),
        invariants: invariantsOf(s.members).map(invariant),
        location: loc(s),
    };
}

function command(aggId: ElementId, c: Command, loc: (n: AstNode) => Location, field: (f: Parameter) => FieldModel): CommandModel {
    return {
        id: commandId(aggId, c.name),
        name: c.name,
        ...described(c),
        factory: c.factory,
        params: c.params.map(field),
        transitions: c.transitions.map((t) => ({ from: t.from.map((r) => r.$refText), to: t.to.map((r) => r.$refText) })),
        outcomes: c.outcomes.map(outcome),
        legacy: c.transitions.length > 0 || c.changes.length > 0 || c.emits.length > 0,
        requires: c.requirements.map(requirement),
        changes: [...c.changes],
        emits: c.emits.map((e) => ({
            event: refName(e.event),
            cardinality: cardinality(e.multiplicity),
            multiplicity: multiplicityText(e.multiplicity),
            ...bounds(e.multiplicity),
            ...(e.when && { when: { from: e.when.from.map((r) => r.$refText), to: e.when.to.map((r) => r.$refText) } }),
        })),
        errors: [...new Set([...c.errors, ...c.requirements.map((r) => r.error)].map(refName))],
        location: loc(c),
    };
}

function outcome(o: Outcome): import('../../domain/model.js').OutcomeModel {
    return {
        name: o.name,
        from: o.from.map((r) => r.$refText),
        to: o.to.$refText,
        changes: [...o.changes],
        emits: o.emits.map((e) => ({
            event: refName(e.event),
            cardinality: cardinality(e.multiplicity),
            multiplicity: multiplicityText(e.multiplicity),
            ...bounds(e.multiplicity),
            ...(e.when && { when: { from: e.when.from.map((r) => r.$refText), to: e.when.to.map((r) => r.$refText) } }),
        })),
        ...(o.selectExpr
            ? { select: { kind: 'expression' as const, source: sourceText(o.selectExpr), expr: exprModel(o.selectExpr) } }
            : o.selectText !== undefined
              ? {
                    select: o.external
                        ? { kind: 'external' as const, text: o.selectText, reason: o.external.reason }
                        : { kind: 'declared' as const, text: o.selectText },
                }
              : {}),
    };
}

function group(g: TransitionGroup): import('../../domain/model.js').TransitionGroupModel {
    return {
        field: g.field,
        enum: g.values[0]?.enum.ref ? qname(g.values[0].enum.ref) : qualifiedName(g.values[0]?.enum.$refText ?? ''),
        values: g.values.map((v) => v.value),
        initials: g.members.filter(isInitial).map((i) => ({ state: i.state.$refText, kinds: g.values.map((v) => v.value) })),
        cases: g.members
            .filter(isCommandCase)
            .map((c) => ({ command: c.command.$refText, requires: c.requirements.map(requirement), outcomes: c.outcomes.map(outcome) })),
    };
}

function lifecycleOf(agg: import('./generated/ast.js').Aggregate): { lifecycleField?: string; lifecycleEnum?: QualifiedName } {
    const first = agg.members.find(isTransitionGroup);
    return first
        ? {
              lifecycleField: first.field,
              lifecycleEnum: first.values[0]?.enum.ref ? qname(first.values[0].enum.ref) : qualifiedName(first.values[0]?.enum.$refText ?? ''),
          }
        : {};
}

function validStatesOf(agg: import('./generated/ast.js').Aggregate): import('../../domain/model.js').ValidKindStatesModel[] {
    const groups = agg.members.filter(isTransitionGroup);
    if (!groups.length) return [];
    const values = groups.flatMap((g) => g.values.map((v) => v.value));
    const enumDecl = groups[0]?.values[0]?.enum.ref;
    const kinds = enumDecl?.values.map((v) => v.name) ?? [...new Set(values)];
    const common = agg.members.filter(isInitial).map((i) => i.state.$refText);
    return kinds.map((kind) => {
        const selected = groups.filter((g) => g.values.some((v) => v.value === kind));
        const seen = new Set([...common, ...selected.flatMap((g) => g.members.filter(isInitial).map((i) => i.state.$refText))]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const c of agg.members.filter((m): m is Command => m.$type === 'Command')) {
                for (const t of c.factory ? [] : c.transitions)
                    if (t.to.length === 1 && t.from.some((f) => seen.has(f.$refText))) {
                        const target = t.to[0]!.$refText;
                        if (!seen.has(target)) {
                            seen.add(target);
                            changed = true;
                        }
                    }
                const cases = selected.flatMap((g) => g.members.filter(isCommandCase).filter((x) => x.command.$refText === c.name));
                for (const o of [...c.outcomes, ...cases.flatMap((x) => x.outcomes)]) {
                    if (!c.factory && o.from.some((f) => seen.has(f.$refText))) {
                        if (!seen.has(o.to.$refText)) {
                            seen.add(o.to.$refText);
                            changed = true;
                        }
                    }
                }
            }
        }
        return { kind, states: [...seen] };
    });
}
