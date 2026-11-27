import { commandsOf, kindsOf, statesOf, type AggregateDecl, type CommandDecl, type KindDecl, type OutcomeDecl } from './source-model.js';

export interface LifecycleReachability {
    kind: string;
    initial: string[];
    creationTargets: string[];
    reachableFromInitial: string[];
    reachable: string[];
}

/** Initial and reachable lifecycle states, independently for each aggregate kind. */
export function lifecyclesOf(aggregate: AggregateDecl): LifecycleReachability[] {
    // Known duplicate: for invalid multi-target transitions and kinds without creation this differs from Typed Model
    // validStatesFor; unify when the generator moves to the IR.
    const kinds = kindsOf(aggregate);
    const commands = commandsOf(aggregate);
    if (!statesOf(aggregate).length && kinds.length) return [];
    const casesOf = (kind: KindDecl | undefined, cmd: CommandDecl) => kind?.cases.filter((c) => c.command.text === cmd.name) ?? [];
    const applicable = (cmd: CommandDecl, kind: KindDecl | undefined): OutcomeDecl[] =>
        cmd.ofKind && cmd.ofKind !== kind?.name ? [] : [...cmd.outcomes, ...casesOf(kind, cmd).flatMap((c) => c.outcomes)];
    const legacyTargets = (cmd: CommandDecl, kind: KindDecl | undefined): string[] =>
        cmd.ofKind && cmd.ofKind !== kind?.name ? [] : cmd.transitions.flatMap((t) => t.to.map((r) => r.text));
    const commonInitials = aggregate.members.filter((m) => m.kind === 'initial').map((m) => m.state.text);
    const kindInitials = (kind: KindDecl): string[] => kind.members.filter((m) => m.kind === 'initial').map((m) => m.state.text);

    return (kinds.length ? kinds : [undefined]).map((kind) => {
        const creationTargets = commands.filter((c) => c.factory).flatMap((c) => [...applicable(c, kind).map((o) => o.to.text), ...legacyTargets(c, kind)]);
        const initial = new Set([...commonInitials, ...(kind ? kindInitials(kind) : []), ...(kind ? creationTargets : [])]);
        const reachableFromInitial = new Set(initial);
        const reachable = new Set([...initial, ...creationTargets]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const cmd of commands.filter((c) => !c.factory && (!c.ofKind || c.ofKind === kind?.name))) {
                for (const transition of cmd.transitions.filter((t) => t.to.length === 1))
                    if (transition.from.some((f) => reachable.has(f.text)) && !reachable.has(transition.to[0]!.text)) {
                        reachable.add(transition.to[0]!.text);
                        changed = true;
                    }
                for (const outcome of applicable(cmd, kind))
                    if (outcome.from.some((f) => reachable.has(f.text)) && !reachable.has(outcome.to.text)) {
                        reachable.add(outcome.to.text);
                        changed = true;
                    }
            }
        }
        // M028 reachability is based only on declared initials; factory targets remain separate for the IR.
        let initialChanged = true;
        while (initialChanged) {
            initialChanged = false;
            for (const cmd of commands.filter((c) => !c.factory && (!c.ofKind || c.ofKind === kind?.name))) {
                for (const transition of cmd.transitions.filter((t) => t.to.length === 1))
                    if (transition.from.some((f) => reachableFromInitial.has(f.text)) && !reachableFromInitial.has(transition.to[0]!.text)) {
                        reachableFromInitial.add(transition.to[0]!.text);
                        initialChanged = true;
                    }
                for (const outcome of applicable(cmd, kind))
                    if (outcome.from.some((f) => reachableFromInitial.has(f.text)) && !reachableFromInitial.has(outcome.to.text)) {
                        reachableFromInitial.add(outcome.to.text);
                        initialChanged = true;
                    }
            }
        }
        return { kind: kind?.name ?? '*', initial: [...initial], creationTargets, reachableFromInitial: [...reachableFromInitial], reachable: [...reachable] };
    });
}
