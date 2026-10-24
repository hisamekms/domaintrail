import type { AstNode } from 'langium';
import { isEntity, isIdType, isValueObject, type Aggregate, type Command, type ErrorDecl, type EventDecl, type IdType, type State } from '../../language/generated/ast.js';
import { emitApplies } from '../../model/model.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, commonFields, fieldsOf, identityField, includedFields, type FieldLike, type ModelIndex } from '../model-index.js';
import { distance } from '../suggest.js';
import { baseType, cardinality, sameType, type Ty } from '../types.js';

/** At most this many sources of the same type are named in a warning. */
const MAX_CANDIDATES = 3;

/** A value a command has at hand: a parameter, a field of a parameter, or a field of the aggregate. */
interface Source {
    /** As written in the warning: `at`, `item.sku`, `placedAt`. */
    path: string;
    /** The name a payload field takes after it: `at`, `sku`, `placedAt`. */
    name: string;
    kind: 'parameter' | 'field';
    type: Ty | undefined;
}

type Typed = Pick<FieldLike, 'type' | 'multiplicity'>;

/**
 * The type a value is compared by: the base type, and whether it is a collection. An optional value counts as a single
 * one, so an optional source may give a required field and the other way round. `undefined` when the type is not known
 * (reported elsewhere), so it matches nothing.
 */
function valueType(m: Typed): Ty | undefined {
    const base = baseType(m.type);
    if (base.k === 'error') return undefined;
    const c = cardinality(m.multiplicity);
    return c === 'many' || c === 'nonEmpty' ? { k: 'list', elem: base } : base;
}

/** Built-in types whose values are often computed (counts, totals, flags): a source of the same type proves nothing. */
const GENERIC = new Set(['Int', 'Decimal', 'Bool']);

const matches = (a: Ty | undefined, b: Ty | undefined): boolean => !!a && !!b && sameType(a, b);

/** The command's parameters, and the fields one level inside a single parameter of a value object or entity type. */
function parameterSources(cmd: Command): Source[] {
    const own: Source[] = cmd.params.map((p) => ({ path: p.name, name: p.name, kind: 'parameter', type: valueType(p) }));
    const nested: Source[] = cmd.params.flatMap((p) => {
        const decl = p.type?.decl?.ref;
        if (!decl || !(isEntity(decl) || isValueObject(decl)) || valueType(p)?.k === 'list') return [];
        const fields = [...includedFields(decl).map((x) => x.field), ...fieldsOf(decl.members)];
        return fields.map((f): Source => ({ path: `${p.name}.${f.name}`, name: f.name, kind: 'parameter', type: valueType(f) }));
    });
    return [...own, ...nested];
}

/** The aggregate's common fields (also from field sets), and the fields of the given states. */
function aggregateSources(agg: Aggregate, states: Iterable<State | undefined>): Source[] {
    const fields = [...includedFields(agg).map((x) => x.field), ...commonFields(agg)];
    for (const s of new Set(states)) if (s) fields.push(...fieldsOf(s.members));
    return fields.map((f) => ({ path: f.name, name: f.name, kind: 'field', type: valueType(f) }));
}

/**
 * M022 (warning): a field of an event that a command emits, or of an error that it may return, likely takes its value
 * from a source of another name. The sources are the command's parameters, the fields of a parameter of a value object
 * or entity type, and the aggregate's fields: common ones, and for an event those of the target states of the outcomes
 * it is emitted for (the aggregate after the command), for an error those of the source states (the aggregate before;
 * none for a factory). A payload field is fine when a source has the same name and type, or when its type is the
 * aggregate's ID type (M017); otherwise it is reported if some source has its type. Without one, the value is computed
 * (a total, say). Fields of the built-in types Int, Decimal and Bool are computed often enough (counts, sums, flags)
 * that they are not reported at all. Types match by base type, optionality aside; a collection matches only a
 * collection of the same element type. Reported once per command and payload field, at the
 * first `emits` entry, `else` or `errors` reference of the event or error.
 */
export function checkPayloadNames(index: ModelIndex, sink: DiagnosticSink): void {
    for (const agg of index.aggregates) {
        const id = identityField(agg)?.type?.decl?.ref;
        const idType = id && isIdType(id) ? id : undefined;
        for (const cmd of commandsOf(agg)) {
            const params = parameterSources(cmd);
            const outcomes = cmd.transitions.flatMap((t) =>
                (cmd.factory ? [undefined] : t.from.map((r) => r.ref)).flatMap((from) => t.to.map((r) => ({ from, to: r.ref }))),
            );
            const report = { cmd, idType, sink };

            const events = new Map<EventDecl, { node: AstNode; targets: Set<State | undefined> }>();
            for (const e of cmd.emits) {
                const ev = e.event.ref;
                if (!ev) continue;
                const pattern = e.when && { from: e.when.from.map((r) => r.$refText), to: e.when.to.map((r) => r.$refText) };
                const entry = events.get(ev) ?? { node: e, targets: new Set() };
                for (const o of outcomes) if (emitApplies({ when: pattern }, o.from?.name, o.to?.name)) entry.targets.add(o.to);
                events.set(ev, entry);
            }
            for (const [ev, { node, targets }] of events) {
                checkPayload(report, 'event', ev, [...params, ...aggregateSources(agg, targets)], { node, property: 'event' });
            }

            const before = cmd.factory ? params : [...params, ...aggregateSources(agg, outcomes.map((o) => o.from))];
            const errors = new Map<ErrorDecl, Location>();
            for (const r of cmd.requirements) {
                const err = r.error?.ref;
                if (err && !errors.has(err)) errors.set(err, { node: r, property: 'error' });
            }
            cmd.errors.forEach((ref, i) => {
                const err = ref.ref;
                if (err && !errors.has(err)) errors.set(err, { node: cmd, property: 'errors', index: i });
            });
            for (const [err, at] of errors) checkPayload(report, 'error', err, before, at);
        }
    }
}

/** Where a payload's warnings go: its first `emits` entry, `else` or `errors` reference in the command. */
interface Location {
    node: AstNode;
    property: string;
    index?: number;
}

function checkPayload(
    { cmd, idType, sink }: { cmd: Command; idType: IdType | undefined; sink: DiagnosticSink },
    what: 'event' | 'error',
    decl: EventDecl | ErrorDecl,
    sources: Source[],
    at: Location,
): void {
    for (const f of [...includedFields(decl).map((x) => x.field), ...decl.members]) {
        if (idType && f.type?.decl?.ref === idType) continue;
        const type = valueType(f);
        if (!type || (type.k === 'prim' && GENERIC.has(type.name))) continue;
        if (sources.some((s) => s.name === f.name && matches(s.type, type))) continue;
        const keys = new Set<string>();
        const candidates = sources
            .filter((s) => matches(s.type, type) && !keys.has(`${s.kind} ${s.path}`) && keys.add(`${s.kind} ${s.path}`))
            .map((s, i) => ({ s, i, d: distance(f.name.toLowerCase(), s.name.toLowerCase()) }))
            .sort((a, b) => a.d - b.d || a.i - b.i)
            .slice(0, MAX_CANDIDATES)
            .map((x) => x.s);
        if (!candidates.length) continue;
        const named = sources.some((s) => s.name === f.name);
        sink.warning(
            'M022',
            `Field '${f.name}' of ${what} '${decl.name}' has no source of the same name${named ? ' and type' : ''} in command '${cmd.name}'; ${describe(candidates)} ${candidates.length === 1 ? 'has' : 'have'} its type.`,
            at.node,
            at.property,
            at.index,
            renameHint(what, f.name, candidates[0]),
        );
    }
}

/** `parameter 'at'`, `parameters 'at', 'item.sku' and field 'note'`. */
function describe(sources: Source[]): string {
    const groups = (['parameter', 'field'] as const)
        .map((kind) => sources.filter((s) => s.kind === kind).map((s) => `'${s.path}'`))
        .map((names, i) => (names.length ? `${i === 0 ? 'parameter' : 'field'}${names.length > 1 ? 's' : ''} ${names.join(', ')}` : ''))
        .filter(Boolean);
    return groups.join(' and ');
}

function renameHint(what: 'event' | 'error', field: string, best: Source): string {
    const rename =
        best.path === best.name
            ? `rename the ${best.kind} '${best.name}' to '${field}' (or the ${what} field to '${best.name}')`
            : `rename the ${what} field to '${best.name}', after parameter '${best.path}'`;
    return `name them alike: ${rename}, so that the value's source is clear`;
}
