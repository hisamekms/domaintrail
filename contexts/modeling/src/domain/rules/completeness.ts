// Design D (Phase 2): an outcome that makes a field exist determines its value. A create sets every non-optional field
// of the aggregate (its common fields, those of its kind and those of its target state), and a transition every
// non-optional field new in its target state, through `changes x` (a value the model leaves open) or
// `changes x = expr` (its value). An optional field left out is `null`.
import type { RuleSink } from '../diagnostics.js';
import {
    commandsOf,
    commonFields,
    fieldsOf,
    includedFields,
    kindFields,
    kindsOf,
    type AggregateDecl,
    type CommandDecl,
    type FieldDecl,
    type KindDecl,
    type OutcomeDecl,
    type Site,
    type SourceModel,
    type StateDecl,
} from '../source-model.js';
import { cardinality, memberType, multiplicityText, sameType } from '../types.js';

const required = (f: FieldDecl): boolean => cardinality(f.multiplicity) !== 'optional';

/**
 * Whether a source state's field is carried over as the target's: the same name, kind, multiplicity and type (as
 * `outcomeFields` of the Typed Model); a field of that name of another type is new in the target.
 */
const sameField = (f: FieldDecl, g: FieldDecl): boolean =>
    f.name === g.name &&
    f.kind === g.kind &&
    multiplicityText(f.multiplicity) === multiplicityText(g.multiplicity) &&
    f.aggregate?.text === g.aggregate?.text &&
    sameType(memberType(f), memberType(g));

/** What an outcome must set: the field, and a parameter of the command of that name to suggest. */
export interface MissingValue {
    readonly field: FieldDecl;
    readonly outcome: string;
    /** The command, and the kind of an `on` case's outcome, that the outcome belongs to. */
    readonly command: string;
    readonly kind?: string;
    readonly param?: string;
    readonly at: Site;
}

/** The non-optional fields each outcome of an aggregate must set and does not. */
export function missingValues(agg: AggregateDecl): MissingValue[] {
    const common = [...includedFields(agg).map((x) => x.field), ...commonFields(agg)];
    const kinds = kindsOf(agg);
    const out: MissingValue[] = [];
    const check = (
        cmd: CommandDecl,
        kind: KindDecl | undefined,
        name: string,
        from: readonly StateDecl[],
        to: readonly StateDecl[],
        changes: CommandDecl['changes'],
        at: Site,
        caseKind?: string,
    ): void => {
        const set = new Set(changes.map((c) => c.name));
        const stateFields = (s: StateDecl): FieldDecl[] => fieldsOf(s.members);
        const target = to.flatMap(stateFields);
        // the fields that come into existence: all of them on create, else those of the target no source state has
        const fresh = cmd.factory
            ? [...common, ...(kind ? kindFields(kind) : []), ...target]
            : target.filter((f) => !from.length || from.some((s) => !stateFields(s).some((g) => sameField(f, g))));
        for (const f of fresh)
            if (
                required(f) &&
                !set.has(f.name) &&
                f.name !== undefined &&
                !out.some((m) => m.outcome === name && m.command === cmd.name && m.kind === caseKind && m.field.name === f.name)
            )
                out.push({
                    field: f,
                    outcome: name,
                    command: cmd.name,
                    ...(caseKind && { kind: caseKind }),
                    ...(cmd.params.some((p) => p.name === f.name) && { param: f.name }),
                    at,
                });
    };
    for (const cmd of commandsOf(agg)) {
        const own = kinds.find((k) => k.name === cmd.ofKind);
        const refs = (o: OutcomeDecl) => ({ from: o.from.flatMap((r) => (r.target ? [r.target] : [])), to: o.to.target ? [o.to.target] : [] });
        for (const o of cmd.outcomes) {
            const { from, to } = refs(o);
            // a common create sets the common fields; a kind's fields are set by the kind's own commands (ADR 0037)
            check(cmd, own, o.name, from, to, o.changes, o.nameAt);
        }
        for (const k of kinds)
            for (const c of k.cases.filter((x) => x.command.text === cmd.name))
                for (const o of c.outcomes) {
                    const { from, to } = refs(o);
                    check(cmd, k, o.name, from, to, o.changes, o.nameAt, k.name);
                }
        if (!cmd.outcomes.length && (cmd.factory || cmd.transitions.length))
            for (const t of cmd.transitions.length ? cmd.transitions : [{ from: [], to: [] }]) {
                const from = t.from.flatMap((r) => (r.target ? [r.target] : []));
                const to = t.to.flatMap((r) => (r.target ? [r.target] : []));
                check(cmd, own, cmd.name, from, to, cmd.changes, cmd.nameAt);
            }
    }
    return out;
}

/** M021: an outcome sets every non-optional field it makes exist. */
export function checkCompleteness(model: SourceModel, rules: RuleSink): void {
    for (const el of model.elements) {
        if (el.kind !== 'aggregate') continue;
        for (const m of missingValues(el))
            rules.error(
                'M021',
                `Outcome '${m.outcome}' makes field '${m.field.name}' exist, but does not list it in 'changes'.`,
                m.at,
                m.param
                    ? `write 'changes ${m.field.name} = ${m.param}'`
                    : `write 'changes ${m.field.name} = …', or 'changes ${m.field.name}' when the model leaves its value open (or make the field optional, '?', to start as null)`,
            );
    }
}
