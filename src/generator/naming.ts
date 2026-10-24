import type { AstNode } from 'langium';
import { isAggregate, isEntity, isEventDecl, isIdType, isPrimitiveDecl, isUnionDecl, isValueObject, isVerifiedDecl } from '../language/generated/ast.js';
import { commandsOf, invariantsOf, primitiveInvariants, statesOf, type ModelIndex } from '../core/model-index.js';
import { emitApplies, type OutcomePatternModel } from '../model/model.js';

/** Names exported by the shared runtime module and imported into every context file. */
export const RUNTIME_NAMES = ['Result', 'Ok', 'Err', 'Decimal', 'Timestamp', 'ok', 'err', 'decide', 'Decide', 'Shape', 'NoChanges', 'outcome', 'eventList', 'NoEvents', 'Outcome', 'EventOf', 'sameOptional', 'sameList', 'distinct'] as const;

/** Discriminant property of generated event / error types. */
export const EVENT_TAG = 'type';
/**
 * Start of the property that marks a verified type, followed by its qualified name: `'verified:Sales.AvailableEmail'`.
 * One property per verified type, so that a value verified twice has both and a value verified once lacks the other.
 */
export const VERIFIED_PREFIX = 'verified:';
/** Discriminant property of generated aggregate state types. */
export const STATE_TAG = 'state';

export const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const camel = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

interface Named {
    name: string;
}

export const commonTypeName = (agg: Named): string => `${agg.name}Common`;
export const stateTypeName = (agg: Named, state: Named | string): string =>
    `${typeof state === 'string' ? state : state.name}${agg.name}`;
export const commandTypeName = (agg: Named, cmd: Named): string => `${pascal(cmd.name)}${agg.name}`;
export const commandsInterfaceName = (agg: Named): string => `${agg.name}Commands`;
/** What a command decides, e.g. `ConfirmOrderDecision`: implemented by the user, turned into the command by `decide`. */
export const decisionTypeName = (agg: Named, cmd: Named): string => `${commandTypeName(agg, cmd)}Decision`;
/** The fields of an aggregate as data for `decide`, e.g. `OrderShape`. */
export const shapeName = (agg: Named): string => `${agg.name}Shape`;
/**
 * Whether the outputs of a command depend on its source state, which makes its contract generic over the input state:
 * the targets differ by transition (`A -> A, B -> B`), or the events do (`emits X when A ->`). State names only, as in
 * the Typed Model.
 */
export function outputsVary(factory: boolean, transitions: OutcomePatternModel[], emits: { when?: OutcomePatternModel }[]): boolean {
    if (factory) return false;
    // per source state: each target with the entries of `emits` that apply to it
    const output = (from: string, to: string[]): string =>
        [...new Set(to)].sort().map((t) => `${t}:${emits.flatMap((e, i) => (emitApplies(e, from, t) ? [i] : [])).join(',')}`).join('|');
    return new Set(transitions.flatMap((t) => t.from.map((f) => output(f, t.to)))).size > 1;
}
export const aggregateParamName = (agg: Named): string => camel(agg.name);
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
    IdType: 'id',
    PrimitiveDecl: 'primitive',
    VerifiedDecl: 'verified type',
    EnumDecl: 'enum',
    ValueObject: 'value object',
    UnionDecl: 'union',
    Entity: 'entity',
    EventDecl: 'event',
    ErrorDecl: 'error',
    FieldSet: 'field set',
};

export interface GeneratedName {
    name: string;
    /** Human readable origin, used in collision messages. */
    origin: string;
    node: AstNode;
}

/** All top-level TypeScript names emitted into the file of `ctx`, in declaration order. */
export function generatedNames(index: ModelIndex, ctx: string): GeneratedName[] {
    const out: GeneratedName[] = [];
    const seen = new Set<string>();
    for (const el of index.elementsOf(ctx)) {
        // Duplicate declarations are reported by M002 and generated once.
        if (seen.has(el.name)) continue;
        seen.add(el.name);
        if (!isAggregate(el)) {
            out.push({ name: el.name, origin: `${KIND_LABELS[el.$type]} '${el.name}'`, node: el });
            if (isIdType(el) || isPrimitiveDecl(el)) {
                out.push({ name: makeTypeName(el), origin: `the constructor of '${el.name}'`, node: el });
                const invs = primitiveInvariants(el);
                if (invs.length) out.push({ name: invalidTypeName(el), origin: `the error of '${el.name}'`, node: el });
                const declared = invs.some((i) => !i.expr);
                out.push({ name: `make${el.name}${declared ? 'With' : ''}`, origin: `the generated constructor of '${el.name}'`, node: el });
                if (invs.length) out.push(...checkNames(el.name, declared, el));
            } else if (isVerifiedDecl(el)) {
                out.push({ name: makeTypeName(el), origin: `the factory of '${el.name}'`, node: el });
            } else if (isValueObject(el) || isEntity(el) || isUnionDecl(el)) {
                out.push({ name: `equal${el.name}`, origin: `the equality of '${el.name}'`, node: el });
                const invs = isUnionDecl(el) ? el.variants.flatMap((v) => invariantsOf(v.members)) : invariantsOf(el.members);
                if (invs.length) out.push(...checkNames(el.name, invs.some((i) => !i.expr), el));
            }
            continue;
        }
        const states = firstByName(statesOf(el));
        out.push({ name: el.name, origin: `aggregate '${el.name}'`, node: el });
        out.push({ name: shapeName(el), origin: `the shape of '${el.name}'`, node: el });
        if (states.length > 0) {
            out.push({ name: commonTypeName(el), origin: `common fields of '${el.name}'`, node: el });
            for (const s of states) {
                out.push({ name: stateTypeName(el, s), origin: `state '${el.name}.${s.name}'`, node: s });
            }
        }
        const commands = firstByName(commandsOf(el));
        if (commands.length > 0) {
            out.push({ name: commandsInterfaceName(el), origin: `commands of '${el.name}'`, node: el });
        }
        const invs = [...invariantsOf(el.members), ...states.flatMap((s) => invariantsOf(s.members))];
        if (invs.length) {
            const declared = invs.some((i) => !i.expr);
            out.push(...checkNames(el.name, declared, el));
            for (const s of states) out.push(...checkNames(stateTypeName(el, s), false, s).map((n) => (declared ? { ...n, name: `${n.name}With` } : n)));
        }
        for (const c of commands) {
            out.push({ name: commandTypeName(el, c), origin: `command '${el.name}.${c.name}'`, node: c });
            out.push({ name: decisionTypeName(el, c), origin: `the decision of '${el.name}.${c.name}'`, node: c });
            if (!c.requirements.length) continue;
            const t = commandTypeName(el, c);
            const origin = `the check of the requirements of '${el.name}.${c.name}'`;
            if (c.requirements.some((r) => !r.expr)) {
                out.push({ name: `check${t}RequiresWith`, origin, node: c }, { name: `${t}DeclaredRequires`, origin, node: c });
            } else {
                out.push({ name: `check${t}Requires`, origin, node: c });
            }
        }
        if (commands.some((c) => c.emits.length > 0)) {
            out.push({ name: aggregateEventTypeName(el), origin: `the union of the events of '${el.name}'`, node: el });
        }
    }
    const persistent = index.elementsOf(ctx).find((el) => isEventDecl(el) && el.persistent);
    if (persistent) out.push({ name: PERSISTENT_EVENT_TYPE, origin: 'the union of persistent events', node: persistent });
    const event = index.elementsOf(ctx).find(isEventDecl);
    if (event) out.push({ name: DOMAIN_EVENT_TYPE, origin: 'the union of the events', node: event });
    const aggregate = index.elementsOf(ctx).find(isAggregate);
    if (aggregate) out.push({ name: AGGREGATE_TYPE, origin: 'the union of the aggregates', node: aggregate });
    return out;
}

/** The names of the generated check of a type: `check<T>`, or `check<T>With` and `<T>DeclaredChecks` with a slot. */
function checkNames(type: string, declared: boolean, node: AstNode): GeneratedName[] {
    const origin = `the check of the invariants of '${type}'`;
    return declared ? [{ name: `check${type}With`, origin, node }, { name: `${type}DeclaredChecks`, origin, node }] : [{ name: `check${type}`, origin, node }];
}

/** Drops repeated names (reported by M002) so that they do not also count as generated-name collisions. */
function firstByName<T extends { name: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((i) => !seen.has(i.name) && seen.add(i.name));
}

/** Words that cannot be used as TypeScript parameter or type names. */
export const TS_RESERVED = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
    'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
    'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await',
    'any', 'boolean', 'number', 'string', 'symbol', 'never', 'unknown', 'object', 'undefined', 'bigint',
]);
