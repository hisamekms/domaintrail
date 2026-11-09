import { emitApplies } from '../model.js';
import type { RuleSink } from '../diagnostics.js';
import {
    commandsOf,
    commonFields,
    fieldsOf,
    identityField,
    includedFields,
    statesOf,
    type AggregateDecl,
    type CommandDecl,
    type FieldDecl,
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
            if (cmd.outcomes.length || agg.members.some((m) => m.kind === 'transitionGroup' && m.cases.some((c) => c.command.text === cmd.name))) continue;
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
 * M021: `changes` lists fields that the command can change (ADR 0019):
 *   - not on a `create command`, which sets every field;
 *   - a field of the aggregate — a common field (also from a field set) or a field of a state — other than its identity;
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
        for (const cmd of commandsOf(agg)) {
            if (!cmd.changes.length) continue;
            if (cmd.factory) {
                const hint = `remove 'changes ${cmd.changes.map((c) => c.name).join(', ')}'; the decision of '${cmd.name}' gives every field`;
                rules.error(
                    'M021',
                    `Factory command '${cmd.name}' sets every field of the new '${agg.name}'; 'changes' does not apply to it.`,
                    cmd.changes[0]!.at,
                    hint,
                );
                continue;
            }
            const outcomes = cmd.transitions.flatMap((t) => t.from.flatMap((f) => t.to.map((to) => ({ from: f.target, to: to.target }))));
            for (const { name, at } of cmd.changes) {
                if (name === identity) {
                    rules.error('M021', `Field '${name}' is the identity of '${agg.name}' and never changes.`, at, `remove '${name}' from 'changes'`);
                    continue;
                }
                if (common.some((f) => f.name === name)) continue;
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
                const entered = outcomes.filter(({ to }) => fieldIn(to, name)).map(({ to }) => to!.name);
                const hint = entered.length
                    ? `every outcome of '${cmd.name}' that ends in ${quotedList([...new Set(entered)])} sets '${name}' anyway; remove it from 'changes'`
                    : `'${cmd.name}' never ends in ${quotedList(where)}, so '${name}' is not kept; remove it from 'changes'`;
                rules.error(
                    'M021',
                    `Field '${name}' is in state ${quotedList(where)} only, and no transition of '${cmd.name}' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.`,
                    at,
                    hint,
                );
            }
        }
    }
}
