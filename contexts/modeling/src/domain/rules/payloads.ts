import { emitApplies } from '../model.js';
import type { RuleSink } from '../diagnostics.js';
import {
    commandsOf,
    commonFields,
    fieldsOf,
    identityField,
    includedFields,
    type AggregateDecl,
    type CommandDecl,
    type ErrorDecl,
    type EventDecl,
    type FieldDecl,
    type IdDecl,
    type ParamDecl,
    type Site,
    type SourceModel,
    type StateDecl,
} from '../source-model.js';
import { distance } from '@domaintrail/kernel';
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

type Typed = Pick<FieldDecl | ParamDecl, 'type' | 'multiplicity'>;

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
function parameterSources(cmd: CommandDecl): Source[] {
    const own: Source[] = cmd.params.map((p) => ({ path: p.name, name: p.name, kind: 'parameter', type: valueType(p) }));
    const nested: Source[] = cmd.params.flatMap((p) => {
        const decl = p.type?.decl?.target;
        if (!decl || !(decl.kind === 'entity' || decl.kind === 'valueObject') || valueType(p)?.k === 'list') return [];
        const fields = [...includedFields(decl).map((x) => x.field), ...fieldsOf(decl.members)];
        return fields.map((f): Source => ({ path: `${p.name}.${f.name}`, name: f.name, kind: 'parameter', type: valueType(f) }));
    });
    return [...own, ...nested];
}

/** The aggregate's common fields (also from field sets), and the fields of the given states. */
function aggregateSources(agg: AggregateDecl, states: Iterable<StateDecl | undefined>): Source[] {
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
export function checkPayloadNames(model: SourceModel, rules: RuleSink): void {
    for (const agg of model.elements) {
        if (agg.kind !== 'aggregate') continue;
        const id = identityField(agg)?.type?.decl?.target;
        const idType = id?.kind === 'id' ? id : undefined;
        for (const cmd of commandsOf(agg)) {
            const params = parameterSources(cmd);
            const legacy = cmd.transitions.flatMap((t) =>
                (cmd.factory ? [undefined] : t.from.map((r) => r.target)).flatMap((from) => t.to.map((r) => ({ from, to: r.target }))),
            );
            const cases = agg.members.filter((m) => m.kind === 'transitionGroup').flatMap((g) => g.cases.filter((c) => c.command.text === cmd.name));
            const named = [...cmd.outcomes, ...cases.flatMap((c) => c.outcomes)];
            const outcomes = [
                ...legacy,
                ...named.flatMap((o) => (cmd.factory ? [undefined] : o.from.map((r) => r.target)).map((from) => ({ from, to: o.to.target }))),
            ];
            const report = { cmd, idType, rules };

            const events = new Map<EventDecl, { at: Site; targets: Set<StateDecl | undefined> }>();
            for (const e of cmd.emits) {
                const ev = e.event.target;
                if (!ev) continue;
                const pattern = e.when && { from: e.when.from.map((r) => r.text), to: e.when.to.map((r) => r.text) };
                const entry = events.get(ev) ?? { at: e.event.at, targets: new Set() };
                for (const o of outcomes) if (emitApplies({ when: pattern }, o.from?.name, o.to?.name)) entry.targets.add(o.to);
                events.set(ev, entry);
            }
            for (const o of named)
                for (const e of o.emits) {
                    const ev = e.event.target;
                    if (!ev) continue;
                    const entry = events.get(ev) ?? { at: e.event.at, targets: new Set<StateDecl | undefined>() };
                    entry.targets.add(o.to.target);
                    events.set(ev, entry);
                }
            for (const [ev, { at, targets }] of events) {
                checkPayload(report, 'event', ev, [...params, ...aggregateSources(agg, targets)], at);
            }

            const before = cmd.factory
                ? params
                : [
                      ...params,
                      ...aggregateSources(
                          agg,
                          outcomes.map((o) => o.from),
                      ),
                  ];
            const errors = new Map<ErrorDecl, Site>();
            for (const r of [...cmd.requirements, ...cases.flatMap((c) => c.requirements)]) {
                const err = r.error.target;
                if (err && !errors.has(err)) errors.set(err, r.error.at);
            }
            for (const ref of cmd.errors) {
                const err = ref.target;
                if (err && !errors.has(err)) errors.set(err, ref.at);
            }
            for (const [err, at] of errors) checkPayload(report, 'error', err, before, at);
        }
    }
}

function checkPayload(
    { cmd, idType, rules }: { cmd: CommandDecl; idType: IdDecl | undefined; rules: RuleSink },
    what: 'event' | 'error',
    decl: EventDecl | ErrorDecl,
    sources: Source[],
    /** Where its warnings go: its first `emits` entry, `else` or `errors` reference in the command. */
    at: Site,
): void {
    for (const f of [...includedFields(decl).map((x) => x.field), ...decl.members]) {
        if (idType && f.type?.decl?.target === idType) continue;
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
        rules.warning(
            'M022',
            `Field '${f.name}' of ${what} '${decl.name}' has no source of the same name${named ? ' and type' : ''} in command '${cmd.name}'; ${describe(candidates)} ${candidates.length === 1 ? 'has' : 'have'} its type.`,
            at,
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
