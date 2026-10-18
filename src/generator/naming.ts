import type { AstNode } from 'langium';
import { isAggregate, isEventDecl, isIdType, isPrimitiveDecl } from '../language/generated/ast.js';
import { commandsOf, primitiveInvariants, statesOf, type ModelIndex } from '../core/model-index.js';

/** Names exported by the shared runtime module and imported into every context file. */
export const RUNTIME_NAMES = ['Result', 'Ok', 'Err', 'Decimal', 'Timestamp', 'ok', 'err'] as const;

/** Discriminant property of generated event / error types. */
export const EVENT_TAG = 'type';
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
export const aggregateParamName = (agg: Named): string => camel(agg.name);
/** Constructor contract of a domain primitive, e.g. `MakeQuantity`. */
export const makeTypeName = (p: Named): string => `Make${p.name}`;
/** Error returned when a value violates a domain primitive's invariants, e.g. `InvalidQuantity`. */
export const invalidTypeName = (p: Named): string => `Invalid${p.name}`;
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
                if (primitiveInvariants(el).length) out.push({ name: invalidTypeName(el), origin: `the error of '${el.name}'`, node: el });
            }
            continue;
        }
        const states = firstByName(statesOf(el));
        out.push({ name: el.name, origin: `aggregate '${el.name}'`, node: el });
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
        for (const c of commands) {
            out.push({ name: commandTypeName(el, c), origin: `command '${el.name}.${c.name}'`, node: c });
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
