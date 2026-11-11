import { emitApplies, written, type OutcomePatternModel, type Site, type SourceModel } from '@domaintrail/modeling';
import { camel } from '@domaintrail/kernel';

/** Names exported by the shared runtime module and imported into every context file. */
export const RUNTIME_NAMES = [
    'Result',
    'Ok',
    'Err',
    'Decimal',
    'Timestamp',
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

export const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

interface Named {
    name: string;
}

export const commonTypeName = (agg: Named): string => `${agg.name}Common`;
export const stateTypeName = (agg: Named, state: Named | string): string => `${typeof state === 'string' ? state : state.name}${agg.name}`;
export const commandTypeName = (agg: Named, cmd: Named): string => `${pascal(cmd.name)}${agg.name}`;
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
        const lifecycleKinds = [...new Set(el.members.filter((m) => m.kind === 'transitionGroup').flatMap((g) => g.values.map((v) => v.value)))];
        if (states.length > 0) {
            out.push({ name: commonTypeName(el), origin: `common fields of '${el.name}'`, at });
            const commonDeclared = written.invariantsOf(el.members).some((i) => !i.expr);
            out.push({ name: `check${commonTypeName(el)}${commonDeclared ? 'With' : ''}`, origin: `the check of the invariants of '${el.name}'`, at });
            for (const s of states) {
                out.push({ name: stateTypeName(el, s), origin: `state '${el.name}.${s.name}'`, at: s.nameAt });
                for (const kind of lifecycleKinds)
                    out.push({ name: `${kind}${stateTypeName(el, s)}`, origin: `kind–state '${el.name}.${kind}.${s.name}'`, at: s.nameAt });
            }
        }
        const commands = firstByName(written.commandsOf(el));
        if (commands.length > 0) {
            out.push({ name: commandsInterfaceName(el), origin: `commands of '${el.name}'`, at });
        }
        const invs = [...written.invariantsOf(el.members), ...states.flatMap((s) => written.invariantsOf(s.members))];
        if (invs.length) {
            const declared = invs.some((i) => !i.expr);
            out.push(...checkNames(el.name, declared, at));
            for (const s of states) out.push(...checkNames(stateTypeName(el, s), false, s.nameAt).map((n) => (declared ? { ...n, name: `${n.name}With` } : n)));
        }
        for (const c of commands) {
            const cat = c.nameAt;
            out.push({ name: commandTypeName(el, c), origin: `command '${el.name}.${c.name}'`, at: cat });
            if (c.params.length) out.push({ name: paramsTypeName(el, c), origin: `the parameters of '${el.name}.${c.name}'`, at: cat });
            out.push({ name: decisionTypeName(el, c), origin: `the decision of '${el.name}.${c.name}'`, at: cat });
            const groupCases = el.members.filter((m) => m.kind === 'transitionGroup').flatMap((g) => g.cases.filter((x) => x.command.text === c.name));
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
            el.members.some((m) => m.kind === 'transitionGroup' && m.cases.some((x) => x.outcomes.some((o) => o.emits.length > 0)))
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
