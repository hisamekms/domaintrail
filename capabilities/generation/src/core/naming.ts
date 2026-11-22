import { emitApplies, written, type OutcomePatternModel, type Site, type SourceModel } from '@domaintrail/modeling';
import { camel } from '@domaintrail/kernel';

/** Names exported by the shared runtime module and imported into every context file. */
export const RUNTIME_NAMES = [
    'Result',
    'Ok',
    'Err',
    'Decimal',
    'Timestamp',
    'PlainDate',
    'PlainTime',
    'PlainYearMonth',
    'parseDate',
    'parseTime',
    'parseYearMonth',
    'parseTimestamp',
    'timestampOf',
    'ok',
    'err',
    'decide',
    'decideNamed',
    'Decide',
    'ChoiceVerifier',
    'Shape',
    'NoChanges',
    'outcome',
    'eventList',
    'NoEvents',
    'Outcome',
    'EventOf',
    'sameOptional',
    'sameList',
    'distinct',
    'parseDecimal',
    'decimalCompare',
    'Availability',
    'CommandUnavailable',
    'CommandNotForKind',
    'CommandOf',
    'DecideByKind',
    'decideByKind',
    'isAvailable',
    'availableCommands',
    'fromAnyState',
] as const;

/** Discriminant property of generated event / error types. */
export const EVENT_TAG = 'type';
/** Runtime-readable errors returned by each command's decision, per context. */
export const COMMAND_ERRORS_NAME = 'commandErrors';
/**
 * Start of the property that marks a verified type, followed by its qualified name: `'verified:Sales.AvailableEmail'`.
 * One property per verified type, so that a value verified twice has both and a value verified once lacks the other.
 */
export const VERIFIED_PREFIX = 'verified:';
/** Discriminant property of generated aggregate state types. */
export const STATE_TAG = 'state';
/** Discriminant property of the kinds of an aggregate (ADR 0037). */
export const KIND_TAG = 'kind';

export const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

interface Named {
    name: string;
}

export const commonTypeName = (agg: Named): string => `${agg.name}Common`;
export const stateTypeName = (agg: Named, state: Named | string): string => `${typeof state === 'string' ? state : state.name}${agg.name}`;
export const commandTypeName = (agg: Named, cmd: Named): string => `${pascal(cmd.name)}${agg.name}`;
/** An aggregate of one kind (ADR 0037), in any state: `StorePickupSite`. */
export const kindTypeName = (agg: Named, kind: Named | string): string => `${typeof kind === 'string' ? kind : kind.name}${agg.name}`;
/** An aggregate of one kind in one state: `StoreActivePickupSite`. */
export const pairTypeName = (agg: Named, kind: Named | string, state: Named | string): string =>
    `${typeof kind === 'string' ? kind : kind.name}${stateTypeName(agg, state)}`;
/** The guard of an aggregate's kind: `isStorePickupSite`. */
export const isKindName = (agg: Named, kind: Named | string): string => `is${kindTypeName(agg, kind)}`;
export const commandsInterfaceName = (agg: Named): string => `${agg.name}Commands`;
/** What a command decides, e.g. `ConfirmOrderDecision`: implemented by the user, turned into the command by `decide`. */
export const decisionTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}Decision`;
export const choiceChecksTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}ChoiceChecks`;
export const choiceCheckName = (agg: Named, cmd: Named): string => `check${commandTypeName(agg, cmd)}Choice`;
/** The parameters of a command as one object, e.g. `CancelOrderParams`; a command without parameters has none. */
export const paramsTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}Params`;
/** The fields of an aggregate as data for `decide`, e.g. `OrderShape`. */
export const shapeName = (agg: Named): string => `${agg.name}Shape`;
export const restoreName = (agg: Named): string => `restore${agg.name}`;
/** Where the commands of an aggregate can be called, as data (`OrderAvailability`). */
export const availabilityName = (agg: Named): string => `${agg.name}Availability`;
/** The guard of whether a command can be called on an aggregate in its state (`canCancelOrder`). */
export const canName = (agg: Named, cmd: Named): string => `can${commandTypeName(agg, cmd)}`;
/** The error of a command called in a state that is not one of its source states (`CancelOrderUnavailable`). */
export const unavailableTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}Unavailable`;
/** The error of a command called on an aggregate of a kind that does not have it (`ChangeClosingTimePickupSiteNotForKind`). */
export const notForKindTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}NotForKind`;
/** A command for an aggregate in any state (`CancelOrderFromAnyState`). */
export const anyStateTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}FromAnyState`;
/** The commands of an aggregate for an aggregate in any state (`OrderCommandsFromAnyState`). */
export const anyStateInterfaceName = (agg: Named): string => `${agg.name}CommandsFromAnyState`;
/** Makes `OrderCommandsFromAnyState` of the hand-written commands (`anyStateOrderCommands`). */
export const anyStateFunctionName = (agg: Named): string => `anyState${agg.name}Commands`;
/** The commands that can be called on an aggregate in its state (`availableOrderCommands`). */
export const availableCommandsName = (agg: Named): string => `available${agg.name}Commands`;
/**
 * Whether the outputs of a command depend on its source state, which makes its contract generic over the input state:
 * the targets differ by transition (`A -> A, B -> B`), or the events do (`emits X when A ->`). State names only, as in
 * the Typed Model.
 */
export function outputsVary(factory: boolean, transitions: readonly OutcomePatternModel[], emits: readonly { readonly when?: OutcomePatternModel }[]): boolean {
    if (factory) return false;
    // per source state: each target with the entries of `emits` that apply to it
    const output = (from: string, to: readonly string[]): string =>
        [...new Set(to)]
            .sort()
            .map((t) => `${t}:${emits.flatMap((e, i) => (emitApplies(e, from, t) ? [i] : [])).join(',')}`)
            .join('|');
    return new Set(transitions.flatMap((t) => t.from.map((f) => output(f, t.to)))).size > 1;
}
export const aggregateParamName = (agg: Named): string => camel(agg.name);
/** The name of a command's parameters object in its contract and checks: `params`, unless the aggregate is `Params`. */
export const paramsArgName = (agg: Named): string => (aggregateParamName(agg) === 'params' ? 'parameters' : 'params');
/** The handler of a policy, e.g. `BillConfirmedOrderPolicy`: from the event to the input of its command. */
export const policyTypeName = (policy: Named): string => `${policy.name}Policy`;
/** What the application needs to run a command that a policy runs, e.g. `IssueInvoiceInput`. */
export const inputTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}Input`;
/** The handlers of every policy of a context, e.g. `BillingPolicyHandlers`; implemented when policies are required. */
export const policyHandlersName = (ctx: string): string => `${ctx}PolicyHandlers`;
/** Constructor contract of a domain primitive, e.g. `MakeQuantity`; the factory of a verified type, e.g. `MakeAvailableEmail`. */
export const makeTypeName = (p: Named): string => `Make${p.name}`;
/** Error returned when a value violates a domain primitive's invariants, e.g. `InvalidQuantity`. */
export const invalidTypeName = (p: Named): string => `Invalid${p.name}`;
/** Runtime type of the `set` of an outcome that gives no field. */
export const NO_CHANGES_TYPE = 'NoChanges';
/** Runtime type of the `events` of an outcome that emits none. */
export const NO_EVENTS_TYPE = 'NoEvents';
/** Union of the events of a context that are declared `persistent`; generated only when there is one. */
export const PERSISTENT_EVENT_TYPE = 'PersistentEvent';
/** Union of the events of a context; generated only when there is one. */
export const DOMAIN_EVENT_TYPE = 'DomainEvent';
/** Union of the aggregates of a context; generated only when there is one. */
export const AGGREGATE_TYPE = 'Aggregate';
/** Union of the events the commands of an aggregate may emit, e.g. `OrderEvent`; generated only when there is one. */
export const aggregateEventTypeName = (agg: Named): string => `${agg.name}Event`;

const KIND_LABELS: Record<string, string> = {
    id: 'id',
    primitive: 'primitive',
    verified: 'verified type',
    enum: 'enum',
    valueObject: 'value object',
    union: 'union',
    entity: 'entity',
    event: 'event',
    error: 'error',
    fieldSet: 'field set',
};

export interface GeneratedName {
    name: string;
    /** Human readable origin, used in collision messages. */
    origin: string;
    /** The name of the declaration it comes from, where a collision is reported. */
    at: Site;
}

/** All top-level TypeScript names emitted into the file of `ctx`, in declaration order. */
export function generatedNames(model: SourceModel, ctx: string): GeneratedName[] {
    const out: GeneratedName[] = [];
    const seen = new Set<string>();
    /** Commands run by a policy, whose input is generated once. */
    const inputs = new Set<unknown>();
    const elements = written.elementsOf(model, ctx);
    for (const el of elements) {
        // Duplicate declarations are reported by M002 and generated once.
        if (seen.has(el.name)) continue;
        seen.add(el.name);
        const at = el.nameAt;
        if (el.kind === 'policy') {
            out.push({ name: policyTypeName(el), origin: `the handler of policy '${el.name}'`, at });
            const agg = el.aggregate.target;
            const cmd = el.command.target;
            if (agg && cmd && !inputs.has(cmd)) {
                inputs.add(cmd);
                out.push({ name: inputTypeName(agg, cmd), origin: `the input of '${agg.name}.${cmd.name}'`, at });
            }
            continue;
        }
        if (el.kind !== 'aggregate') {
            out.push({ name: el.name, origin: `${KIND_LABELS[el.kind]} '${el.name}'`, at });
            if (el.kind === 'id' || el.kind === 'primitive') {
                out.push({ name: makeTypeName(el), origin: `the constructor of '${el.name}'`, at });
                const invs = written.primitiveInvariants(el);
                const checked = invs.length > 0 || el.base === 'UUID'; // a UUID base adds the invariant 'uuid'
                if (checked) out.push({ name: invalidTypeName(el), origin: `the error of '${el.name}'`, at });
                const declared = invs.some((i) => !i.expr);
                out.push({ name: `make${el.name}${declared ? 'With' : ''}`, origin: `the generated constructor of '${el.name}'`, at });
                if (checked) out.push(...checkNames(el.name, declared, at));
            } else if (el.kind === 'verified') {
                out.push({ name: makeTypeName(el), origin: `the factory of '${el.name}'`, at });
            } else if (el.kind === 'valueObject' || el.kind === 'entity' || el.kind === 'union') {
                out.push({ name: `equal${el.name}`, origin: `the equality of '${el.name}'`, at });
                const invs = el.kind === 'union' ? el.variants.flatMap((v) => written.invariantsOf(v.members)) : written.invariantsOf(el.members);
                if (invs.length)
                    out.push(
                        ...checkNames(
                            el.name,
                            invs.some((i) => !i.expr),
                            at,
                        ),
                    );
            }
            continue;
        }
        const states = firstByName(written.statesOf(el));
        out.push({ name: el.name, origin: `aggregate '${el.name}'`, at });
        out.push({ name: shapeName(el), origin: `the shape of '${el.name}'`, at });
        out.push({ name: restoreName(el), origin: `the trusted restore function of '${el.name}'`, at });
        const kinds = firstByName(written.kindsOf(el));
        if (states.length > 0 || kinds.length > 0) {
            out.push({ name: commonTypeName(el), origin: `common fields of '${el.name}'`, at });
            const commonDeclared = written.invariantsOf(el.members).some((i) => !i.expr);
            out.push({ name: `check${commonTypeName(el)}${commonDeclared ? 'With' : ''}`, origin: `the check of the invariants of '${el.name}'`, at });
            for (const s of states) {
                out.push({ name: stateTypeName(el, s), origin: `state '${el.name}.${s.name}'`, at: s.nameAt });
                for (const k of kinds) out.push({ name: pairTypeName(el, k, s), origin: `kind–state '${el.name}.${k.name}.${s.name}'`, at: s.nameAt });
            }
            for (const k of kinds) {
                out.push({ name: kindTypeName(el, k), origin: `kind '${el.name}.${k.name}'`, at: k.nameAt });
                out.push({ name: isKindName(el, k), origin: `the guard of kind '${el.name}.${k.name}'`, at: k.nameAt });
                if (written.invariantsOf(k.members).length)
                    out.push(
                        ...checkNames(
                            kindTypeName(el, k),
                            written.invariantsOf(k.members).some((i) => !i.expr),
                            k.nameAt,
                        ),
                    );
            }
        }
        const commands = firstByName(written.commandsOf(el));
        if (commands.length > 0) {
            out.push({ name: commandsInterfaceName(el), origin: `commands of '${el.name}'`, at });
        }
        // where the commands can be called (ADR 0036, 0037): for an aggregate with states or kinds, and a command that takes one
        const available = states.length > 0 || kinds.length > 0 ? commands.filter((c) => !c.factory) : [];
        if (available.length > 0) {
            out.push({ name: availabilityName(el), origin: `the availability of the commands of '${el.name}'`, at });
            out.push({ name: availableCommandsName(el), origin: `the available commands of '${el.name}'`, at });
            out.push({ name: anyStateInterfaceName(el), origin: `the any-state commands of '${el.name}'`, at });
            out.push({ name: anyStateFunctionName(el), origin: `the any-state commands of '${el.name}'`, at });
            for (const c of available) {
                const origin = `the availability of '${el.name}.${c.name}'`;
                out.push({ name: canName(el, c), origin, at: c.nameAt }, { name: unavailableTypeName(el, c), origin, at: c.nameAt });
                if (kinds.length) out.push({ name: notForKindTypeName(el, c), origin, at: c.nameAt });
                out.push({ name: anyStateTypeName(el, c), origin, at: c.nameAt });
            }
        }
        const invs = [
            ...written.invariantsOf(el.members),
            ...states.flatMap((s) => written.invariantsOf(s.members)),
            ...kinds.flatMap((k) => written.invariantsOf(k.members)),
        ];
        if (invs.length || kinds.length) {
            const declared = invs.some((i) => !i.expr);
            out.push(...checkNames(el.name, declared, at));
            for (const s of states) out.push(...checkNames(stateTypeName(el, s), false, s.nameAt).map((n) => (declared ? { ...n, name: `${n.name}With` } : n)));
        }
        for (const c of commands) {
            const cat = c.nameAt;
            out.push({ name: commandTypeName(el, c), origin: `command '${el.name}.${c.name}'`, at: cat });
            if (c.params.length) out.push({ name: paramsTypeName(el, c), origin: `the parameters of '${el.name}.${c.name}'`, at: cat });
            out.push({ name: decisionTypeName(el, c), origin: `the decision of '${el.name}.${c.name}'`, at: cat });
            const groupCases = kinds.flatMap((k) => k.cases.filter((x) => x.command.text === c.name));
            if (c.outcomes.length || groupCases.length) {
                out.push({ name: choiceChecksTypeName(el, c), origin: `choice checks of '${el.name}.${c.name}'`, at: cat });
                out.push({ name: choiceCheckName(el, c), origin: `choice checker of '${el.name}.${c.name}'`, at: cat });
            }
            const requirements = [...c.requirements, ...groupCases.flatMap((x) => x.requirements)];
            if (!requirements.length) continue;
            const t = commandTypeName(el, c);
            const origin = `the check of the requirements of '${el.name}.${c.name}'`;
            if (requirements.some((r) => !r.expr)) {
                out.push({ name: `check${t}RequiresWith`, origin, at: cat }, { name: `${t}DeclaredRequires`, origin, at: cat });
            } else {
                out.push({ name: `check${t}Requires`, origin, at: cat });
            }
        }
        if (
            commands.some((c) => c.emits.length > 0 || c.outcomes.some((o) => o.emits.length > 0)) ||
            kinds.some((k) => k.cases.some((x) => x.outcomes.some((o) => o.emits.length > 0)))
        ) {
            out.push({ name: aggregateEventTypeName(el), origin: `the union of the events of '${el.name}'`, at });
        }
    }
    const persistent = elements.find((el) => el.kind === 'event' && el.persistent);
    if (persistent) out.push({ name: PERSISTENT_EVENT_TYPE, origin: 'the union of persistent events', at: persistent.nameAt });
    const event = elements.find((el) => el.kind === 'event');
    if (event) out.push({ name: DOMAIN_EVENT_TYPE, origin: 'the union of the events', at: event.nameAt });
    const aggregate = elements.find((el) => el.kind === 'aggregate');
    if (aggregate) out.push({ name: AGGREGATE_TYPE, origin: 'the union of the aggregates', at: aggregate.nameAt });
    const policy = elements.find((el) => el.kind === 'policy');
    if (policy) out.push({ name: policyHandlersName(ctx), origin: 'the handlers of the policies', at: policy.nameAt });
    const firstCommand = elements.filter((el) => el.kind === 'aggregate').flatMap((agg) => written.commandsOf(agg))[0];
    if (firstCommand) out.push({ name: COMMAND_ERRORS_NAME, origin: 'the command error catalog', at: firstCommand.nameAt });
    return out;
}

/** The names of the generated check of a type: `check<T>`, or `check<T>With` and `<T>DeclaredChecks` with a slot. */
function checkNames(type: string, declared: boolean, at: Site): GeneratedName[] {
    const origin = `the check of the invariants of '${type}'`;
    return declared
        ? [
              { name: `check${type}With`, origin, at },
              { name: `${type}DeclaredChecks`, origin, at },
          ]
        : [{ name: `check${type}`, origin, at }];
}

/** Drops repeated names (reported by M002) so that they do not also count as generated-name collisions. */
function firstByName<T extends { name: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((i) => !seen.has(i.name) && seen.add(i.name));
}

/** Words that cannot be used as TypeScript parameter or type names. */
export const TS_RESERVED = new Set([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'let',
    'static',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'await',
    'any',
    'boolean',
    'number',
    'string',
    'symbol',
    'never',
    'unknown',
    'object',
    'undefined',
    'bigint',
]);
