import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, statesOf, type ModelIndex } from '../model-index.js';

/**
 * M006: state transitions of commands (`A | B -> C`). Unresolved state names are reported from linking;
 * this checks the transitions against the aggregate kind:
 *   - stateful aggregate, regular command: one or more transitions, each with source states
 *   - stateful aggregate, factory (`create command`): exactly one transition, without source states (`-> Draft`)
 *   - aggregate without states: no transitions
 * A state may be the source of only one transition of a command, so that the input state decides the output states.
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
        }
    }
}
