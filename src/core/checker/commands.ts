import { isIdType, type Command } from '../../language/generated/ast.js';
import { emitApplies } from '../../model/model.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, identityField, statesOf, type ModelIndex } from '../model-index.js';

/**
 * M006: state transitions of commands (`A | B -> C`). Unresolved state names are reported from linking;
 * this checks the transitions against the aggregate kind:
 *   - stateful aggregate, regular command: one or more transitions, each with source states
 *   - stateful aggregate, factory (`create command`): exactly one transition, without source states (`-> Draft`)
 *   - aggregate without states: no transitions
 * A state may be the source of only one transition of a command, so that the input state decides the output states.
 * `emits X when A -> B` names sources and targets of the command and matches at least one of its outcomes.
 */
export function checkCommands(index: ModelIndex, sink: DiagnosticSink): void {
    for (const agg of index.aggregates) {
        const stateful = statesOf(agg).length > 0;
        for (const cmd of commandsOf(agg)) {
            const label = `${cmd.factory ? 'Factory command' : 'Command'} '${cmd.name}'`;
            if (!stateful) {
                if (cmd.transitions.length > 0) {
                    const hint = `remove the transitions, or declare the states of '${agg.name}' with 'state Name'`;
                    sink.error('M006', `${label} declares state transitions, but aggregate '${agg.name}' has no states.`, cmd, 'transitions', 0, hint);
                }
                for (const e of cmd.emits) {
                    if (e.when) {
                        sink.error('M006', `'when' selects outcomes by state, but aggregate '${agg.name}' has no states.`, e, 'when', undefined, `remove 'when …' (then '${e.event.$refText}' is emitted on every success), or split the command`);
                    }
                }
                continue;
            }
            if (cmd.factory) {
                if (cmd.transitions.length !== 1) {
                    sink.error('M006', `${label} must declare exactly one transition to its initial state(s), e.g. '-> Draft'.`, cmd, cmd.transitions.length ? 'transitions' : 'name', cmd.transitions.length ? 1 : undefined);
                }
                cmd.transitions.forEach((t) => {
                    if (t.from.length > 0) sink.error('M006', `${label} creates a new '${agg.name}' and cannot have source states; write '-> ${t.to.map((r) => r.$refText).join(' | ')}'.`, t, 'from');
                });
            } else {
                if (cmd.transitions.length === 0) {
                    sink.error('M006', `${label} must declare its state transitions, e.g. 'Draft -> Submitted' (or be declared with 'create command').`, cmd, 'name');
                }
                cmd.transitions.forEach((t) => {
                    if (t.from.length === 0) sink.error('M006', `${label} has a transition without source states; write 'State -> ...' (only a 'create command' starts with '->').`, t);
                });
            }
            const sources = new Set<string>();
            for (const t of cmd.transitions) {
                t.from.forEach((r, i) => {
                    if (sources.has(r.$refText)) {
                        sink.error('M006', `State '${r.$refText}' is the source of more than one transition of command '${cmd.name}'; its outcome must be decided by one transition (use 'A -> B | C').`, t, 'from', i);
                    }
                    sources.add(r.$refText);
                });
                const targets = new Set<string>();
                t.to.forEach((r, i) => {
                    if (targets.has(r.$refText)) sink.warning('M006', `State '${r.$refText}' is listed more than once.`, t, 'to', i);
                    targets.add(r.$refText);
                });
            }
            checkEmitPatterns(cmd, sink);
        }
    }
}

/** `emits X when A -> B`: the states are sources / targets of the command, and the pattern matches one of its outcomes. */
function checkEmitPatterns(cmd: Command, sink: DiagnosticSink): void {
    const outcomes = cmd.transitions.flatMap((t) =>
        (cmd.factory ? [undefined] : t.from.map((r) => r.$refText)).flatMap((from) => t.to.map((r) => ({ from, to: r.$refText }))),
    );
    const sources = new Set(outcomes.map((o) => o.from));
    const targets = new Set(outcomes.map((o) => o.to));
    for (const e of cmd.emits) {
        const w = e.when;
        if (!w) continue;
        const event = e.event.$refText;
        if (w.from.length === 0 && w.to.length === 0) {
            sink.error('M006', `'when' needs a source or a target state.`, w, undefined, undefined, `write 'when ${[...sources][0] ?? 'Draft'} ->' (from a state) or 'when -> ${[...targets][0] ?? 'Completed'}' (into a state)`);
            continue;
        }
        if (cmd.factory && w.from.length > 0) {
            sink.error('M006', `Factory command '${cmd.name}' has no source state to select by.`, w, 'from', undefined, `select by the new aggregate's state: 'when -> ${w.to.map((r) => r.$refText).join(' | ') || [...targets].join(' | ')}'`);
            continue;
        }
        let unknown = false;
        w.from.forEach((r, i) => {
            if (!r.ref || sources.has(r.$refText)) return;
            unknown = true;
            sink.error('M006', `State '${r.$refText}' is not a source state of command '${cmd.name}', so '${event}' can never be emitted from it.`, w, 'from', i, `use a source state of '${cmd.name}': ${[...sources].join(', ')}`);
        });
        w.to.forEach((r, i) => {
            if (!r.ref || targets.has(r.$refText)) return;
            unknown = true;
            sink.error('M006', `State '${r.$refText}' is not a target state of command '${cmd.name}', so '${event}' can never be emitted when it ends there.`, w, 'to', i, `use a target state of '${cmd.name}': ${[...targets].join(', ')}`);
        });
        if (unknown || [...w.from, ...w.to].some((r) => !r.ref)) continue;
        const pattern = { from: w.from.map((r) => r.$refText), to: w.to.map((r) => r.$refText) };
        if (!outcomes.some((o) => emitApplies({ when: pattern }, o.from, o.to))) {
            const all = outcomes.map((o) => `${o.from ?? ''} -> ${o.to}`.trim()).join(', ');
            sink.error('M006', `'when' matches no transition of command '${cmd.name}', so '${event}' is never emitted.`, w, undefined, undefined, `its outcomes are ${all}; leave out one side of 'when', or remove '${event}'`);
        }
    }
}

/**
 * M020 (warning): a `create command` takes the new aggregate's ID as a parameter. Commands are pure functions of
 * their inputs, so a factory cannot make the ID itself.
 */
export function checkFactoryIds(index: ModelIndex, sink: DiagnosticSink): void {
    for (const agg of index.aggregates) {
        const idType = identityField(agg)?.type?.decl?.ref;
        if (!idType || !isIdType(idType)) continue; // reported by M013
        for (const cmd of commandsOf(agg)) {
            if (!cmd.factory || cmd.params.some((p) => p.type?.decl?.ref === idType && !p.multiplicity)) continue;
            sink.warning(
                'M020',
                `Factory command '${cmd.name}' of '${agg.name}' has no parameter of type '${idType.name}', so it would have to make the new ${agg.name}'s ID itself; commands are pure.`,
                cmd,
                'name',
                undefined,
                `pass the ID in: 'create command ${cmd.name}(id: ${idType.name}${cmd.params.length ? ', …' : ''})', and let the caller generate it`,
            );
        }
    }
}
