import { emitApplies } from '../model.js';
import type { RuleSink } from '../diagnostics.js';
import {
    commandsOf,
    kindFields,
    kindsOf,
    commonFields,
    fieldsOf,
    identityField,
    includedFields,
    statesOf,
    type AggregateDecl,
    type CommandDecl,
    type FieldDecl,
    type Site,
    type SourceModel,
    type StateDecl,
} from '../source-model.js';
import { suggestFrom } from '@domaintrail/kernel';
import { baseType, multiplicityText, sameType } from '../types.js';

const aggregatesOf = (model: SourceModel): AggregateDecl[] => model.elements.filter((el): el is AggregateDecl => el.kind === 'aggregate');

/**
 * M006: state transitions of commands (`A | B -> C`). Unresolved state names are reported from linking;
 * this checks the transitions against the aggregate kind:
 *   - stateful aggregate, regular command: one or more transitions, each with source states
 *   - stateful aggregate, factory (`create command`): exactly one transition, without source states (`-> Draft`)
 *   - aggregate without states: no transitions
 * A state may be the source of only one transition of a command, so that the input state decides the output states.
 * `emits X when A -> B` names sources and targets of the command and matches at least one of its outcomes.
 */
export function checkCommands(model: SourceModel, rules: RuleSink): void {
    for (const agg of aggregatesOf(model)) {
        const stateful = statesOf(agg).length > 0;
        for (const cmd of commandsOf(agg)) {
            if (cmd.outcomes.length || kindsOf(agg).some((k) => k.cases.some((c) => c.command.text === cmd.name))) continue;
            const label = `${cmd.factory ? 'Factory command' : 'Command'} '${cmd.name}'`;
            if (!stateful) {
                if (cmd.transitions.length > 0) {
                    const hint = `remove the transitions, or declare the states of '${agg.name}' with 'state Name'`;
                    rules.error('M006', `${label} declares state transitions, but aggregate '${agg.name}' has no states.`, cmd.transitionsAt[0]!, hint);
                }
                for (const e of cmd.emits) {
                    if (e.when) {
                        rules.error(
                            'M006',
                            `'when' selects outcomes by state, but aggregate '${agg.name}' has no states.`,
                            e.whenAt,
                            `remove 'when …' (then '${e.event.text}' is emitted on every success), or split the command`,
                        );
                    }
                }
                continue;
            }
            if (cmd.factory) {
                if (cmd.transitions.length !== 1) {
                    rules.error(
                        'M006',
                        `${label} must declare exactly one transition to its initial state(s), e.g. '-> Draft'.`,
                        cmd.transitions.length ? cmd.transitionsAt[1]! : cmd.nameAt,
                    );
                }
                for (const t of cmd.transitions) {
                    if (t.from.length > 0)
                        rules.error(
                            'M006',
                            `${label} creates a new '${agg.name}' and cannot have source states; write '-> ${t.to.map((r) => r.text).join(' | ')}'.`,
                            t.from[0]!.at,
                        );
                }
            } else {
                if (cmd.transitions.length === 0) {
                    rules.error(
                        'M006',
                        `${label} must declare its state transitions, e.g. 'Draft -> Submitted' (or be declared with 'create command').`,
                        cmd.nameAt,
                    );
                }
                for (const t of cmd.transitions) {
                    if (t.from.length === 0)
                        rules.error(
                            'M006',
                            `${label} has a transition without source states; write 'State -> ...' (only a 'create command' starts with '->').`,
                            t.at,
                        );
                }
            }
            const sources = new Set<string>();
            for (const t of cmd.transitions) {
                for (const r of t.from) {
                    if (sources.has(r.text)) {
                        rules.error(
                            'M006',
                            `State '${r.text}' is the source of more than one transition of command '${cmd.name}'; its outcome must be decided by one transition (use 'A -> B | C').`,
                            r.at,
                        );
                    }
                    sources.add(r.text);
                }
                const targets = new Set<string>();
                for (const r of t.to) {
                    if (targets.has(r.text)) rules.warning('M006', `State '${r.text}' is listed more than once.`, r.at);
                    targets.add(r.text);
                }
            }
            checkEmitPatterns(cmd, rules);
        }
    }
}

/** `emits X when A -> B`: the states are sources / targets of the command, and the pattern matches one of its outcomes. */
function checkEmitPatterns(cmd: CommandDecl, rules: RuleSink): void {
    const outcomes = cmd.transitions.flatMap((t) =>
        (cmd.factory ? [undefined] : t.from.map((r) => r.text)).flatMap((from) => t.to.map((r) => ({ from, to: r.text }))),
    );
    const sources = new Set(outcomes.map((o) => o.from));
    const targets = new Set(outcomes.map((o) => o.to));
    for (const e of cmd.emits) {
        const w = e.when;
        if (!w) continue;
        const event = e.event.text;
        if (w.from.length === 0 && w.to.length === 0) {
            rules.error(
                'M006',
                `'when' needs a source or a target state.`,
                w.at,
                `write 'when ${[...sources][0] ?? 'Draft'} ->' (from a state) or 'when -> ${[...targets][0] ?? 'Completed'}' (into a state)`,
            );
            continue;
        }
        if (cmd.factory && w.from.length > 0) {
            rules.error(
                'M006',
                `Factory command '${cmd.name}' has no source state to select by.`,
                w.from[0]!.at,
                `select by the new aggregate's state: 'when -> ${w.to.map((r) => r.text).join(' | ') || [...targets].join(' | ')}'`,
            );
            continue;
        }
        let unknown = false;
        for (const r of w.from) {
            if (!r.target || sources.has(r.text)) continue;
            unknown = true;
            rules.error(
                'M006',
                `State '${r.text}' is not a source state of command '${cmd.name}', so '${event}' can never be emitted from it.`,
                r.at,
                `use a source state of '${cmd.name}': ${[...sources].join(', ')}`,
            );
        }
        for (const r of w.to) {
            if (!r.target || targets.has(r.text)) continue;
            unknown = true;
            rules.error(
                'M006',
                `State '${r.text}' is not a target state of command '${cmd.name}', so '${event}' can never be emitted when it ends there.`,
                r.at,
                `use a target state of '${cmd.name}': ${[...targets].join(', ')}`,
            );
        }
        if (unknown || [...w.from, ...w.to].some((r) => !r.target)) continue;
        const pattern = { from: w.from.map((r) => r.text), to: w.to.map((r) => r.text) };
        if (!outcomes.some((o) => emitApplies({ when: pattern }, o.from, o.to))) {
            const all = outcomes.map((o) => `${o.from ?? ''} -> ${o.to}`.trim()).join(', ');
            rules.error(
                'M006',
                `'when' matches no transition of command '${cmd.name}', so '${event}' is never emitted.`,
                w.at,
                `its outcomes are ${all}; leave out one side of 'when', or remove '${event}'`,
            );
        }
    }
}

/**
 * M020 (warning): a `create command` takes the new aggregate's ID as a parameter. Commands are pure functions of
 * their inputs, so a factory cannot make the ID itself.
 */
export function checkFactoryIds(model: SourceModel, rules: RuleSink): void {
    for (const agg of aggregatesOf(model)) {
        const idType = identityField(agg)?.type?.decl?.target;
        if (idType?.kind !== 'id') continue; // reported by M013
        for (const cmd of commandsOf(agg)) {
            if (!cmd.factory || cmd.params.some((p) => p.type?.decl?.target === idType && !multiplicityText(p.multiplicity))) continue;
            rules.warning(
                'M020',
                `Factory command '${cmd.name}' of '${agg.name}' has no parameter of type '${idType.name}', so it would have to make the new ${agg.name}'s ID itself; commands are pure.`,
                cmd.nameAt,
                `pass the ID in: 'create command ${cmd.name}(id: ${idType.name}${cmd.params.length ? ', …' : ''})', and let the caller generate it`,
            );
        }
    }
}

/**
 * Whether two fields have the same type: base type, multiplicity, and kind (with the target of a reference). The
 * Typed Model's `sameFieldType` says the same for the generator.
 */
const sameField = (a: FieldDecl, b: FieldDecl): boolean =>
    a.kind === b.kind &&
    sameType(baseType(a.type), baseType(b.type)) &&
    multiplicityText(a.multiplicity) === multiplicityText(b.multiplicity) &&
    (a.kind !== 'references' || b.kind !== 'references' || a.aggregate?.target === b.aggregate?.target);

const quotedList = (names: string[]): string => names.map((n) => `'${n}'`).join(', ');

/**
 * M021 for a path in `changes` (`schedule.plannedDate`): the unit of `changes` is a field of the aggregate, and a
 * field is changed whole (ADR 0019). Reports the path and says what to write instead: the field itself, or — for a
 * single value whose parts change under different commands — the parts as fields of the aggregate. Returns whether
 * `name` is a path; a command's and an outcome's `changes` both use it.
 */
export function checkChangedPath(agg: AggregateDecl, name: string, at: Site, rules: RuleSink): boolean {
    const [root, ...rest] = name.split('.');
    if (!rest.length) return false;
    const fields = [
        ...includedFields(agg).map((x) => x.field),
        ...commonFields(agg),
        ...kindsOf(agg).flatMap(kindFields),
        ...statesOf(agg).flatMap((s) => fieldsOf(s.members)),
    ];
    const field = fields.find((f) => f.name === root);
    if (!field) {
        const names = [...new Set(fields.map((f) => f.name))].filter((f) => f !== identityField(agg)?.name);
        rules.error('M021', `'${agg.name}' has no field '${root}'.`, at, suggestFrom(root!, names, `a field of '${agg.name}'`));
        return true;
    }
    const type = field.type?.decl?.target;
    const single = !field.multiplicity || field.multiplicity.optional;
    const part = rest.at(-1)!;
    if (type?.kind === 'valueObject' && single) {
        rules.error(
            'M021',
            `'changes' takes a field of '${agg.name}', not a part of one: '${name}' is inside '${root}' (${type.name}), and a value is replaced whole.`,
            at,
            `write 'changes ${root}' and give the whole new ${type.name}; if its parts change under different commands, make them fields of '${agg.name}' (share them with a 'fields' set) and write 'changes ${part}'`,
        );
        return true;
    }
    rules.error(
        'M021',
        `'changes' takes a field of '${agg.name}', not a part of one: '${name}' is inside '${root}'.`,
        at,
        `write 'changes ${root}'; the decision gives its whole new value`,
    );
    return true;
}

/**
 * M021: `changes` lists fields that the command can change (ADR 0019):
 *   - not on a `create command`, which sets every field;
 *   - a field of the aggregate — a common field (also from a field set) or a field of a state — other than its identity;
 *   - a field, not a path into one (`checkChangedPath`);
 *   - a state-specific field is carried over by at least one outcome of the command: a transition from a state that
 *     has it to a state that has it, with the same type. In the other outcomes it is new in the target (and set
 *     anyway) or not in the target (and dropped), so listing a field no outcome carries over would change nothing.
 * A field listed twice is M002.
 */
export function checkChanges(model: SourceModel, rules: RuleSink): void {
    for (const agg of aggregatesOf(model)) {
        const common = [...includedFields(agg).map((x) => x.field), ...commonFields(agg)];
        const states = statesOf(agg);
        const fieldIn = (s: StateDecl | undefined, name: string): FieldDecl | undefined => s && fieldsOf(s.members).find((f) => f.name === name);
        const identity = identityField(agg)?.name;
        const kinds = kindsOf(agg);
        for (const cmd of commandsOf(agg)) {
            if (!cmd.changes.length) continue;
            // a kind's command also changes the fields of its kind (ADR 0037)
            const own = [...common, ...kinds.filter((k) => k.name === cmd.ofKind).flatMap(kindFields)];
            const outcomes = cmd.transitions.flatMap((t) => t.from.flatMap((f) => t.to.map((to) => ({ from: f.target, to: to.target }))));
            for (const { name, at } of cmd.changes) {
                if (checkChangedPath(agg, name, at, rules)) continue;
                // a create sets the fields of the new aggregate, its identity and readonly fields included (design D)
                if (name === identity && !cmd.factory) {
                    rules.error('M021', `Field '${name}' is the identity of '${agg.name}' and never changes.`, at, `remove '${name}' from 'changes'`);
                    continue;
                }
                const field = own.find((f) => f.name === name);
                if (field) {
                    if (field.readonly && !cmd.factory)
                        rules.error('M021', `Readonly field '${name}' cannot be changed by command '${cmd.name}'.`, at, `remove '${name}' from 'changes'`);
                    continue;
                }
                const inKinds = kinds.filter((k) => kindFields(k).some((f) => f.name === name)).map((k) => k.name);
                if (inKinds.length) {
                    rules.error(
                        'M021',
                        `Field '${name}' exists only in kind ${quotedList(inKinds)}, and '${cmd.name}' is ${cmd.ofKind ? `a command of kind '${cmd.ofKind}'` : 'a common command'}.`,
                        at,
                        `change '${name}' in a command of kind '${inKinds[0]}' (or in its 'on ${cmd.name}' case), or make '${name}' a common field`,
                    );
                    continue;
                }
                const where = states.filter((s) => fieldIn(s, name)).map((s) => s.name);
                if (!where.length) {
                    const fields = [...common.map((f) => f.name), ...states.flatMap((s) => fieldsOf(s.members).map((f) => f.name))].filter(
                        (f) => f !== identity,
                    );
                    rules.error('M021', `'${agg.name}' has no field '${name}'.`, at, suggestFrom(name, fields, `a field of '${agg.name}'`));
                    continue;
                }
                if (
                    outcomes.some(({ from, to }) => {
                        const a = fieldIn(from, name);
                        const b = fieldIn(to, name);
                        return !!a && !!b && sameField(a, b);
                    })
                )
                    continue;
                // a field new in a target state is listed to say what it starts as (design D)
                const entered = [...cmd.transitions.flatMap((t) => t.to.map((r) => r.target)), ...(cmd.factory ? states : [])].filter((to) =>
                    fieldIn(to, name),
                );
                if (entered.length) continue;
                rules.error(
                    'M021',
                    `Field '${name}' is in state ${quotedList(where)} only, and '${cmd.name}' neither keeps it nor ends in a state that has it, so 'changes' cannot apply to it.`,
                    at,
                    `'${cmd.name}' never ends in ${quotedList(where)}; remove '${name}' from 'changes'`,
                );
            }
        }
    }
}
