import type { RuleSink } from '../diagnostics.js';
import { checkChangedPath } from './commands.js';
import { lifecyclesOf } from '../lifecycle.js';
import {
    commandsOf,
    commonFields,
    kindFields,
    kindsOf,
    statesOf,
    type CommandCaseDecl,
    type CommandDecl,
    type KindDecl,
    type OutcomeDecl,
    type SourceModel,
} from '../source-model.js';

function annotation(rule: { expr?: unknown; externalReason?: string; at: import('../source-model.js').Site }, name: string, rules: RuleSink): void {
    if (rule.externalReason === undefined) return;
    if (!rule.externalReason.trim()) rules.error('M028', `External check of '${name}' needs a reason.`, rule.at);
    if (rule.expr) rules.error('M028', `Expression rule '${name}' cannot have an external check annotation.`, rule.at);
}

function declaration(rule: { expr?: unknown; externalReason?: string; at: import('../source-model.js').Site }, name: string, rules: RuleSink): void {
    if (!rule.expr && rule.externalReason === undefined)
        rules.warning('M029', `Decision rule '${name}' is declared in natural language; express it or add @externalCheck before generation.`, rule.at);
}

/** Target-independent lifecycle checks (ADR 0035, with the kinds of ADR 0037). */
export function checkLifecycles(model: SourceModel, rules: RuleSink): void {
    for (const agg of model.elements) {
        if ('members' in agg)
            for (const inv of agg.members.filter((m) => m.kind === 'invariant')) {
                annotation(inv, inv.name, rules);
                declaration(inv, inv.name, rules);
            }
        if (agg.kind === 'union')
            for (const variant of agg.variants)
                for (const inv of variant.members.filter((m) => m.kind === 'invariant')) {
                    annotation(inv, inv.name, rules);
                    declaration(inv, inv.name, rules);
                }
        if (agg.kind === 'id' || agg.kind === 'primitive')
            for (const inv of agg.invariants) {
                annotation(inv, inv.name, rules);
                declaration(inv, inv.name, rules);
            }
        if ('members' in agg) {
            if (agg.kind !== 'aggregate')
                for (const member of agg.members)
                    if ('readonly' in member && member.readonly)
                        rules.error('M028', `'readonly' is defined only for the fields of an aggregate and of its kinds.`, member.at);
            if (agg.kind === 'aggregate')
                for (const state of statesOf(agg))
                    for (const member of state.members)
                        if ('readonly' in member && member.readonly)
                            rules.error('M028', `'readonly' is defined only for the fields of an aggregate and of its kinds.`, member.at);
            if (agg.kind === 'aggregate')
                for (const scope of [...statesOf(agg), ...kindsOf(agg)])
                    for (const inv of scope.members.filter((m) => m.kind === 'invariant')) {
                        annotation(inv, inv.name, rules);
                        declaration(inv, inv.name, rules);
                    }
        }
        if (agg.kind === 'union')
            for (const variant of agg.variants)
                for (const member of variant.members)
                    if ('readonly' in member && member.readonly)
                        rules.error('M028', `'readonly' is defined only for the fields of an aggregate and of its kinds.`, member.at);
        if (agg.kind !== 'aggregate') continue;
        const kinds = kindsOf(agg);
        const commands = commandsOf(agg);
        const casesOf = (kind: KindDecl | undefined, cmd: CommandDecl): CommandCaseDecl[] => kind?.cases.filter((c) => c.command.text === cmd.name) ?? [];
        const newCommands = commands.filter((c) => c.outcomes.length || kinds.some((k) => casesOf(k, c).length));
        const declaredInitials = agg.members.some((m) => m.kind === 'initial') || kinds.some((k) => k.members.some((m) => m.kind === 'initial'));
        if (!kinds.length && !newCommands.length && !declaredInitials) continue;
        for (const k of kinds)
            for (const c of k.cases)
                for (const req of c.requirements) {
                    annotation(req, req.name, rules);
                    declaration(req, req.name, rules);
                }
        for (const cmd of commands)
            for (const req of cmd.requirements) {
                annotation(req, req.name, rules);
                declaration(req, req.name, rules);
            }

        // a common command with a behaviour of its own and kind cases too is M030's: no outcome errors that follow from it
        const mixed = new Set(
            commands.filter(
                (c) =>
                    !c.ofKind && (c.outcomes.length || c.transitions.length || c.changes.length || c.emits.length) && kinds.some((k) => casesOf(k, c).length),
            ),
        );
        const common = commonFields(agg);
        const stateNames = new Set(statesOf(agg).map((s) => s.name));
        /** The fields an outcome of a command may change: the common ones, and those of the kind it is for. */
        const changeable = (kind: KindDecl | undefined) => [...common, ...(kind ? kindFields(kind) : [])];
        const checkOutcome = (cmd: CommandDecl, o: OutcomeDecl, kind: KindDecl | undefined): void => {
            if (cmd.factory && o.from.length) rules.error('M028', `Create outcome '${o.name}' cannot have source states.`, o.at);
            if (!cmd.factory && !o.from.length) rules.error('M028', `Outcome '${o.name}' needs a source state.`, o.at);
            if (!stateNames.has(o.to.text)) return; // linker reports unresolved state
            if (o.select?.text !== undefined && !o.select.text.trim())
                rules.error('M028', `Choice declaration of outcome '${o.name}' must not be empty.`, o.select.at);
            if (o.select?.text !== undefined) declaration({ expr: o.select.expr, externalReason: o.select.externalReason, at: o.select.at }, o.name, rules);
            if (o.select?.externalReason !== undefined && !o.select.externalReason.trim())
                rules.error('M028', `External check of outcome '${o.name}' needs a reason.`, o.select.at);
            if (o.select?.expr && o.select.externalReason !== undefined)
                rules.error('M028', `Expression choice of outcome '${o.name}' cannot have an external check annotation.`, o.select.at);
            for (const emitted of o.emits)
                if (emitted.when) rules.error('M028', `Event '${emitted.event.text}' is already scoped to outcome '${o.name}'; remove 'when'.`, emitted.whenAt);
            const fields = changeable(kind);
            const changedFields = new Set<string>();
            for (const change of o.changes) {
                if (checkChangedPath(agg, change.name, change.at, rules)) continue;
                if (changedFields.has(change.name)) rules.error('M028', `Field '${change.name}' is listed more than once in outcome '${o.name}'.`, change.at);
                changedFields.add(change.name);
                const f = fields.find((x) => x.name === change.name);
                const inKinds = kinds.filter((k) => kindFields(k).some((x) => x.name === change.name)).map((k) => k.name);
                if (!f && inKinds.length)
                    rules.error(
                        'M028',
                        `Field '${change.name}' exists only in kind ${inKinds.map((n) => `'${n}'`).join(', ')}; outcome '${o.name}' is ${kind ? `for kind '${kind.name}'` : 'common to every kind'}.`,
                        change.at,
                        `change it in a command of kind '${inKinds[0]}' or in its 'on ${cmd.name}' case`,
                    );
                else if (!f && !statesOf(agg).some((s) => s.members.some((m) => 'name' in m && m.name === change.name)))
                    rules.error('M028', `Aggregate '${agg.name}' has no field '${change.name}' to change.`, change.at);
                // a create sets the identity (`changes id = id`, design D); any other outcome keeps it
                if (change.name === 'id' && !cmd.factory) rules.error('M028', `Identity field 'id' cannot be changed by outcome '${o.name}'.`, change.at);
                if (f?.readonly) rules.error('M028', `Readonly field '${change.name}' cannot be changed by outcome '${o.name}'.`, change.at);
            }
        };
        for (const cmd of commands) {
            const own = kinds.find((k) => k.name === cmd.ofKind);
            const all = [
                ...cmd.outcomes.map((o) => ({ o, kind: own })),
                ...kinds.flatMap((k) => casesOf(k, cmd).flatMap((c) => c.outcomes.map((o) => ({ o, kind: k })))),
            ];
            // outcome names are unique per kind: the common ones and those of one kind's case
            for (const k of mixed.has(cmd) ? [] : kinds.length ? kinds : [undefined]) {
                const names = new Set<string>();
                for (const { o } of all.filter((x) => x.kind === undefined || x.kind === own || x.kind === k)) {
                    if (names.has(o.name)) rules.error('M028', `Outcome '${o.name}' is declared more than once in command '${cmd.name}'.`, o.nameAt);
                    names.add(o.name);
                }
            }
            for (const { o, kind } of all) checkOutcome(cmd, o, kind);
        }

        const applicable = (cmd: CommandDecl, kind: KindDecl | undefined): OutcomeDecl[] =>
            cmd.ofKind && cmd.ofKind !== kind?.name ? [] : [...cmd.outcomes, ...casesOf(kind, cmd).flatMap((c) => c.outcomes)];
        if (!stateNames.size && kinds.length) continue; // kinds without a lifecycle: nothing to reach

        for (const lifecycle of lifecyclesOf(agg)) {
            const { kind: label } = lifecycle;
            const kind = kinds.find((k) => k.name === lifecycle.kind);
            const initial = new Set(lifecycle.initial);
            const reachable = new Set(lifecycle.reachableFromInitial);
            if (!initial.size && !kind) rules.error('M028', `Lifecycle kind '${label}' of '${agg.name}' has no initial state.`, agg.nameAt);
            for (const cmd of commands.filter((c) => !mixed.has(c))) {
                const outcomes = applicable(cmd, kind);
                for (const o of outcomes) {
                    if (cmd.factory && !initial.has(o.to.text))
                        rules.error('M028', `Create outcome '${o.name}' must end at an initial state for kind '${label}'.`, o.to.at);
                    if (!cmd.factory)
                        for (const source of o.from)
                            if (!reachable.has(source.text))
                                rules.error('M028', `Source state '${source.text}' of outcome '${o.name}' is unreachable for kind '${label}'.`, source.at);
                }
                const bySource = new Map<string, OutcomeDecl[]>();
                for (const o of outcomes)
                    for (const source of cmd.factory ? ['<create>'] : o.from.map((f) => f.text)) bySource.set(source, [...(bySource.get(source) ?? []), o]);
                for (const [source, choices] of bySource) {
                    if (source !== '<create>' && !reachable.has(source)) continue;
                    if (choices.length < 2) continue;
                    for (const o of choices)
                        if (!o.select)
                            rules.error(
                                'M028',
                                `Outcome '${o.name}' needs a select rule because '${cmd.name}' has multiple outcomes from '${source}' for kind '${label}'.`,
                                o.nameAt,
                            );
                }
            }
        }
        for (const cmd of newCommands) {
            if (cmd.transitions.length || cmd.changes.length || cmd.emits.length)
                rules.error('M028', `Command '${cmd.name}' mixes named outcomes with legacy transitions, changes or emits.`, cmd.nameAt);
        }
    }
}
