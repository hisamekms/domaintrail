/**
 * Typed Model: a resolved, serializable view of the domain model. It is the input of the TypeScript generator and of
 * the Graph IR, and is sent to the Live View. Its types are described in `model/*.dt` and generated into
 * `src/generated` (imported as types only, so that the tool runs from the committed output); the helpers over them are
 * written here.
 */
import type * as M from '../generated/Modeling.js';

export type {
    BinaryOp,
    Cardinality,
    CommandModel,
    CommandCaseModel,
    ChoiceRuleModel,
    ContextModel,
    ContextName,
    Described,
    DomainModel,
    ElementId,
    ElementKind,
    ElementModel,
    EmitModel,
    EnumValueModel,
    ExprModel,
    FieldKind,
    FieldModel,
    InvariantModel,
    InitialModel,
    KindModel,
    LabelSource,
    OutcomePatternModel,
    OutcomeModel,
    PolicyModel,
    PrimitiveName,
    QualifiedName,
    Quantifier,
    RequirementModel,
    StateModel,
    TermModel,
    TransitionModel,
    TypeExpr,
    VariantModel,
    VerifiedFor,
    VerifiedModel,
    ValidKindStatesModel,
} from '../generated/Modeling.js';

type ElementModel = M.ElementModel;
type FieldModel = M.FieldModel;

/** The element of a kind (`ElementOf<'aggregate'>`). */
export type ElementOf<K extends M.ElementKind> = Extract<ElementModel, { readonly kind: K }>;
export type AggregateModel = ElementOf<'aggregate'>;
export type UnionModel = ElementOf<'union'>;
export type EnumModel = ElementOf<'enum'>;
export type PolicyElement = ElementOf<'policy'>;
/** The elements that hold fields: value objects, entities, aggregates, events, errors and field sets. */
export type FieldsElement = Extract<ElementModel, { readonly fields: readonly FieldModel[] }>;

/** The elements of a model by stable ID (an element's ID is its qualified name), built once per model. */
const indexes = new WeakMap<M.DomainModel, ReadonlyMap<string, ElementModel>>();
function index(model: M.DomainModel): ReadonlyMap<string, ElementModel> {
    let byId = indexes.get(model);
    if (!byId) {
        byId = new Map(model.elements.map((e) => [e.id, e]));
        indexes.set(model, byId);
    }
    return byId;
}

/** The element with a stable ID or qualified name (`Sales.Order`), if the model has one. */
export const elementOf = (model: M.DomainModel, idOrName: string): ElementModel | undefined => index(model).get(idOrName);

/** Whether the model has an element with this stable ID or qualified name. */
export const hasElement = (model: M.DomainModel, idOrName: string): boolean => index(model).has(idOrName);

/** The context of that name, if the model has it. */
export const contextOf = (model: M.DomainModel, name: string): M.ContextModel | undefined => model.contexts.find((c) => c.name === name);

/** The names of the contexts, in declaration order. */
export const contextNames = (model: M.DomainModel): M.ContextName[] => model.contexts.map((c) => c.name);

/** Shared contexts (shared kernel), whose elements are usable by name from every context. */
export const sharedContexts = (model: M.DomainModel): M.ContextName[] => model.contexts.filter((c) => c.shared).map((c) => c.name);

export const elementsIn = (model: M.DomainModel, ctx: string): ElementModel[] => model.elements.filter((e) => e.context === ctx);

/** The fields an element holds (its own and those of its field sets; an aggregate's common fields); none for the rest. */
export const fieldsOf = (el: ElementModel): readonly FieldModel[] => ('fields' in el ? el.fields : []);

/** The invariants of an element (an aggregate's common ones); none for the kinds without invariants. */
export const invariantsOf = (el: ElementModel): readonly M.InvariantModel[] => ('invariants' in el ? el.invariants : []);

/** The field sets an element names with `with` (qualified names). */
export const fieldSetsOf = (el: ElementModel): readonly M.QualifiedName[] => ('fieldSets' in el ? el.fieldSets : []);

/** The states of an aggregate; none for the other kinds. */
export const statesOf = (el: ElementModel): readonly M.StateModel[] => (el.kind === 'aggregate' ? el.states : []);

/** The commands of an aggregate; none for the other kinds. */
export const commandsOf = (el: ElementModel): readonly M.CommandModel[] => (el.kind === 'aggregate' ? el.commands : []);

/** The discriminator of an aggregate with kinds in the generated code and in expressions: the kind's name. */
export const KIND_TAG = 'kind';

/** The kinds of an aggregate (ADR 0037); none for the other elements and for an aggregate without kinds. */
export const kindsOf = (el: ElementModel): readonly M.KindModel[] => (el.kind === 'aggregate' ? el.kinds : []);

/** The kind of that name of an aggregate. */
export const kindOf = (agg: AggregateModel, name: string | undefined): M.KindModel | undefined => agg.kinds.find((k) => k.name === name);

/** The kinds a command exists for: its own kind, or every kind for a common command (`['*']` without kinds). */
export const commandKinds = (agg: AggregateModel, c: M.CommandModel): string[] => (c.kind ? [c.kind] : agg.kinds.length ? agg.kinds.map((k) => k.name) : ['*']);

/** The `on` case of a kind for a common command, if it has one. */
export const kindCase = (agg: AggregateModel, kind: string, command: string): M.CommandCaseModel | undefined =>
    kindOf(agg, kind)?.cases.find((c) => c.command === command);

/**
 * The outcomes of a command for a kind (`'*'` without kinds): its own, and those of the kind's `on` case. None for a
 * command of another kind.
 */
export const applicableOutcomes = (agg: AggregateModel, command: M.CommandModel, kind: string): M.OutcomeModel[] =>
    command.kind && command.kind !== kind ? [] : [...command.outcomes, ...(kindCase(agg, kind, command.name)?.outcomes ?? [])];

/** Group applicable outcomes by source state, using the create marker for factories. */
export function outcomesBySource(outcomes: readonly M.OutcomeModel[], factory = false): Map<string, M.OutcomeModel[]> {
    const groups = new Map<string, M.OutcomeModel[]>();
    for (const outcome of outcomes)
        for (const source of factory ? ['<create>'] : outcome.from.length ? outcome.from : ['']) groups.set(source, [...(groups.get(source) ?? []), outcome]);
    return groups;
}

/** Named outcomes plus shorthand outcomes expanded once per target (or one stateless outcome). */
export function outcomesOfCommand(command: M.CommandModel, hasStatesOrKindCases = false): M.OutcomeModel[] {
    if (command.outcomes.length)
        return command.outcomes.flatMap((outcome) => (outcome.from.length ? outcome.from : ['']).map((from) => ({ ...outcome, from: from ? [from] : [] })));
    if (command.transitions.length) {
        return command.transitions.flatMap((transition) =>
            transition.to.flatMap((target) =>
                (transition.from.length ? transition.from : ['']).map((from) => ({
                    name: target,
                    from: from ? [from] : [],
                    to: target,
                    changes: command.changes,
                    emits: command.emits,
                })),
            ),
        );
    }
    if (hasStatesOrKindCases) return [];
    return [{ name: '*', from: [], to: '', changes: command.changes, emits: command.emits }];
}

/** The requirements of a command for a kind: the common ones first, then those of the kind's `on` case. */
export const applicableRequirements = (agg: AggregateModel, command: M.CommandModel, kind: string): M.RequirementModel[] => [
    ...command.requires,
    ...(kindCase(agg, kind, command.name)?.requires ?? []),
];

/** Initial and reached states for a kind; empty when the aggregate has no kinds. */
export const validStatesFor = (agg: AggregateModel, kind: string): readonly string[] => agg.validStates.find((v) => v.kind === kind)?.states ?? [];

/** Whether generation needs a user-supplied check and mandatory contract tests. */
export function hasExternalObligations(model: M.DomainModel): boolean {
    const invariant = (items: readonly M.InvariantModel[]): boolean => items.some((i) => !i.expr && !!i.externalReason);
    const requirement = (items: readonly M.RequirementModel[]): boolean => items.some((r) => !r.expr && !!r.externalReason);
    const outcome = (items: readonly M.OutcomeModel[]): boolean => items.some((o) => o.select?.kind === 'external');
    return model.elements.some((el) => {
        if ('invariants' in el && invariant(el.invariants)) return true;
        if (el.kind === 'union' && el.variants.some((v) => invariant(v.invariants))) return true;
        if (el.kind !== 'aggregate') return false;
        if (el.states.some((s) => invariant(s.invariants))) return true;
        if (el.commands.some((c) => requirement(c.requires) || outcome(c.outcomes))) return true;
        return el.kinds.some((k) => invariant(k.invariants) || k.cases.some((c) => requirement(c.requires) || outcome(c.outcomes)));
    });
}

/** The variants of a union; none for the other kinds. */
export const variantsOf = (el: ElementModel): readonly M.VariantModel[] => (el.kind === 'union' ? el.variants : []);

/** The values of an enum; none for the other kinds. */
export const valuesOf = (el: ElementModel): readonly M.EnumValueModel[] => (el.kind === 'enum' ? el.values : []);

/** The policies of the model, in declaration order. */
export const policyList = (model: M.DomainModel): PolicyElement[] => model.elements.filter((e): e is PolicyElement => e.kind === 'policy');

/** The policies that run command `command` of aggregate `aggregate` (qualified). */
export const policiesRunning = (model: M.DomainModel, aggregate: string, command: string): PolicyElement[] =>
    policyList(model).filter((p) => p.policy.aggregate === aggregate && p.policy.command === command);

/** The policies that react to event `event` (qualified). */
export const policiesReactingTo = (model: M.DomainModel, event: string): PolicyElement[] => policyList(model).filter((p) => p.policy.event === event);

/** The element's own fields, without those it takes from field sets. */
export const ownFields = (el: ElementModel): FieldModel[] => fieldsOf(el).filter((f) => !f.fieldSet);

/** Fields of an element, including kind- and state-specific fields of aggregates and the fields of every union variant. */
export const allFieldsOf = (el: ElementModel): FieldModel[] => [
    ...fieldsOf(el),
    ...kindsOf(el).flatMap((k) => k.fields),
    ...statesOf(el).flatMap((s) => s.fields),
    ...variantsOf(el).flatMap((v) => v.fields),
];

/** How a binary operator is written in the DSL. */
export const BINARY_OP_TEXT: Readonly<Record<M.BinaryOp, string>> = {
    implies: 'implies',
    or: 'or',
    and: 'and',
    eq: '==',
    ne: '!=',
    lt: '<',
    le: '<=',
    gt: '>',
    ge: '>=',
};

/** `when` of an `emits` entry as written, e.g. `Confirmed ->` (empty without one). */
export const outcomePatternText = (w: M.OutcomePatternModel | undefined): string =>
    w ? [w.from.join(' | '), '->', w.to.join(' | ')].filter(Boolean).join(' ') : '';

/** The multiplicity and `when` written after the event of an `emits` entry, e.g. `[1..*] when -> Draft`. */
export const emitSuffix = (e: M.EmitModel): string => `${e.multiplicity}${e.when ? ` when ${outcomePatternText(e.when)}` : ''}`.trim();

/** The events a command may emit (qualified names, each once, in the order of `emits`). */
export const emittedEvents = (c: M.CommandModel): M.QualifiedName[] => [
    ...new Set([...c.emits.map((e) => e.event), ...c.outcomes.flatMap((o) => o.emits.map((e) => e.event))]),
];

/** The events a command may emit, with those of the kinds' `on` cases for it. */
export const emittedEventsInAggregate = (agg: AggregateModel, c: M.CommandModel): M.QualifiedName[] => [
    ...new Set([
        ...emittedEvents(c),
        ...agg.kinds.flatMap((k) => k.cases.filter((x) => x.command === c.name).flatMap((x) => x.outcomes.flatMap((o) => o.emits.map((e) => e.event)))),
    ]),
];

/**
 * Whether an `emits` entry applies to the outcome of a command that starts in `from` (`undefined` for a factory or an
 * aggregate without states) and ends in `to`.
 */
export const emitApplies = (e: { readonly when?: M.OutcomePatternModel }, from: string | undefined, to: string | undefined): boolean =>
    !e.when ||
    ((e.when.from.length === 0 || (from !== undefined && e.when.from.includes(from))) &&
        (e.when.to.length === 0 || (to !== undefined && e.when.to.includes(to))));

/** Whether two fields have the same type: base type, multiplicity, and kind (with the target of a reference). */
export const sameFieldType = (a: FieldModel, b: FieldModel): boolean =>
    a.kind === b.kind &&
    a.multiplicity === b.multiplicity &&
    a.target === b.target &&
    (a.type.kind === 'primitive' ? b.type.kind === 'primitive' && a.type.name === b.type.name : b.type.kind === 'ref' && a.type.ref === b.type.ref);

/**
 * What a decision of a command gives for one of its outcomes (ADR 0019), from source state `from` (`undefined` for a
 * factory or an aggregate without states) to target state `to` (`undefined` without states), for the aggregate of kind
 * `kind` (ADR 0037; `undefined` without kinds). A kind's fields count as common fields of that kind:
 *   - `set`: the fields the decision must give — every field for a factory; else the target's own fields that are not
 *     carried over, and the fields in `changes` that the outcome has;
 *   - `carried`: the fields taken from the input unchanged — the common fields not in `changes`, and the state-specific
 *     fields that source and target both have with the same name and type (not in `changes`);
 *   - `dropped`: the source's own fields that are not carried over.
 */
export function outcomeFields(
    agg: AggregateModel,
    c: M.CommandModel,
    from: string | undefined,
    to: string | undefined,
    outcome?: M.OutcomeModel,
    kind?: string,
): { set: FieldModel[]; carried: FieldModel[]; dropped: FieldModel[] } {
    const own = (state: string | undefined): readonly FieldModel[] => agg.states.find((s) => s.name === state)?.fields ?? [];
    const common = [...agg.fields, ...(kindOf(agg, kind ?? c.kind)?.fields ?? [])];
    const target = own(to);
    if (c.factory) return { set: [...common, ...target], carried: [], dropped: [] };
    const source = own(from);
    const changes = new Set(outcome?.changes ?? c.changes);
    const keeps = (f: FieldModel): boolean => source.some((g) => g.name === f.name && sameFieldType(f, g));
    return {
        set: [...common.filter((f) => changes.has(f.name)), ...target.filter((f) => !keeps(f) || changes.has(f.name))],
        carried: [...common, ...target].filter((f) => !changes.has(f.name) && (common.includes(f) || keeps(f))),
        dropped: source.filter((f) => !target.some((g) => g.name === f.name && sameFieldType(f, g))),
    };
}
