import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, statesOf, type ModelIndex } from '../model-index.js';

/**
 * M006: input/output states of commands. Unresolved state names are reported from linking;
 * this checks the shape of `from`/`to` against the aggregate kind:
 *   - stateful aggregate, regular command: `from` and `to` are required
 *   - stateful aggregate, factory (`create command`): no `from`, `to` is required
 *   - aggregate without states: neither `from` nor `to`
 */
export function checkCommands(index: ModelIndex, sink: DiagnosticSink): void {
    for (const agg of index.aggregates) {
        const stateful = statesOf(agg).length > 0;
        for (const cmd of commandsOf(agg)) {
            const label = `${cmd.factory ? 'Factory command' : 'Command'} '${cmd.name}'`;
            if (!stateful) {
                if (cmd.from.length > 0 || cmd.to.length > 0) {
                    sink.error('M006', `${label} declares states, but aggregate '${agg.name}' has no states.`, cmd, cmd.from.length > 0 ? 'from' : 'to');
                }
                continue;
            }
            if (cmd.factory && cmd.from.length > 0) {
                sink.error('M006', `${label} creates a new '${agg.name}' and cannot have input states ('from').`, cmd, 'from');
            }
            if (!cmd.factory && cmd.from.length === 0) {
                sink.error('M006', `${label} must declare its input state(s) with 'from' (or be declared with 'create command').`, cmd, 'name');
            }
            if (cmd.to.length === 0) {
                sink.error('M006', `${label} must declare its output state(s) with 'to'.`, cmd, 'name');
            }
            for (const [prop, refs] of [['from', cmd.from], ['to', cmd.to]] as const) {
                const seen = new Set<string>();
                refs.forEach((r, i) => {
                    if (seen.has(r.$refText)) sink.warning('M006', `State '${r.$refText}' is listed more than once.`, cmd, prop, i);
                    seen.add(r.$refText);
                });
            }
        }
    }
}
