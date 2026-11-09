import type { RuleSink } from '../diagnostics.js';
import { commandsOf, commonFields, statesOf, type CommandDecl, type OutcomeDecl, type SourceModel, type TransitionGroupDecl } from '../source-model.js';

function annotation(rule: { expr?: unknown; externalReason?: string; at: import('../source-model.js').Site }, name: string, rules: RuleSink): void {
    if (rule.externalReason === undefined) return;
    if (!rule.externalReason.trim()) rules.error('M028', `External check of '${name}' needs a reason.`, rule.at);
    if (rule.expr) rules.error('M028', `Expression rule '${name}' cannot have an external check annotation.`, rule.at);
}

function declaration(rule: { expr?: unknown; externalReason?: string; at: import('../source-model.js').Site }, name: string, rules: RuleSink): void {
    if (!rule.expr && rule.externalReason === undefined)
        rules.warning('M029', `Decision rule '${name}' is declared in natural language; express it or add @externalCheck before generation.`, rule.at);
}

/** Target-independent lifecycle checks. M028 is reserved for ADR 0035. */
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
                        rules.error('M028', `'readonly' is currently defined only for common aggregate fields.`, member.at);
            if (agg.kind === 'aggregate')
                for (const state of statesOf(agg))
                    for (const member of state.members)
                        if ('readonly' in member && member.readonly)
                            rules.error('M028', `'readonly' is currently defined only for common aggregate fields.`, member.at);
            if (agg.kind === 'aggregate')
                for (const state of statesOf(agg))
                    for (const inv of state.members.filter((m) => m.kind === 'invariant')) {
                        annotation(inv, inv.name, rules);
                        declaration(inv, inv.name, rules);
                    }
        }
        if (agg.kind === 'union')
            for (const variant of agg.variants)
                for (const member of variant.members)
                    if ('readonly' in member && member.readonly)
                        rules.error('M028', `'readonly' is currently defined only for common aggregate fields.`, member.at);
        if (agg.kind !== 'aggregate') continue;
        const groups = agg.members.filter((m): m is TransitionGroupDecl => m.kind === 'transitionGroup');
        const commands = commandsOf(agg);
        const newCommands = commands.filter((c) => c.outcomes.length || groups.some((g) => g.cases.some((x) => x.command.text === c.name)));
        if (!groups.length && !newCommands.length && !agg.members.some((m) => m.kind === 'initial')) continue;

        const fields = commonFields(agg);
        const fieldName = groups[0]?.field;
        const field = fields.find((f) => f.name === fieldName);
        const enumDecl = field?.type?.decl?.target;
        if (groups.length && (!field?.readonly || enumDecl?.kind !== 'enum' || !!field.multiplicity))
            rules.error('M028', `Lifecycle selector '${fieldName}' must name a required readonly enum field of '${agg.name}'.`, groups[0]!.at);
        for (const g of groups) {
            if (g.field !== fieldName) rules.error('M028', `All lifecycle groups of '${agg.name}' must select the same readonly field '${fieldName}'.`, g.at);
            if (!g.values.length) rules.error('M028', 'A lifecycle group needs at least one enum value.', g.at);
            const names = new Set<string>();
            for (const v of g.values) {
                if (names.has(v.value)) rules.error('M028', `Enum value '${v.value}' is repeated in one selector.`, v.at);
                names.add(v.value);
                if (v.enum.target && v.enum.target !== enumDecl)
                    rules.error('M028', `Selector value '${v.value}' must belong to the enum of '${fieldName}'.`, v.at);
                if (v.enum.target && !v.enum.target.values.some((x) => x.name === v.value))
                    rules.error('M028', `Enum '${v.enum.target.name}' has no value '${v.value}'.`, v.at);
            }
            for (const c of g.cases) {
                if (!c.command.target) continue;
                if (!commands.includes(c.command.target)) rules.error('M028', `'on ${c.command.text}' must reference a command of '${agg.name}'.`, c.at);
            }
        }

        const kinds =
            enumDecl?.kind === 'enum'
                ? enumDecl.values.map((x) => x.name)
                : groups.length
                  ? [...new Set(groups.flatMap((g) => g.values.map((v) => v.value)))]
                  : ['*'];
        const commonInitials = agg.members.filter((m) => m.kind === 'initial').map((m) => m.state.text);
        const stateNames = new Set(statesOf(agg).map((s) => s.name));
        const byCommand = new Map<CommandDecl, OutcomeDecl[]>();
        for (const cmd of commands) {
            for (const req of cmd.requirements) {
                annotation(req, req.name, rules);
                declaration(req, req.name, rules);
            }
            const all = [...cmd.outcomes, ...groups.flatMap((g) => g.cases.filter((c) => c.command.text === cmd.name).flatMap((c) => c.outcomes))];
            byCommand.set(cmd, all);
            const names = new Set<string>();
            for (const o of all) {
                if (names.has(o.name)) rules.error('M028', `Outcome '${o.name}' is declared more than once in command '${cmd.name}'.`, o.nameAt);
                names.add(o.name);
                if (cmd.factory && o.from.length) rules.error('M028', `Create outcome '${o.name}' cannot have source states.`, o.at);
                if (!cmd.factory && !o.from.length) rules.error('M028', `Outcome '${o.name}' needs a source state.`, o.at);
                if (!stateNames.has(o.to.text)) continue; // linker reports unresolved state
                if (o.select?.text !== undefined && !o.select.text.trim())
                    rules.error('M028', `Choice declaration of outcome '${o.name}' must not be empty.`, o.select.at);
                if (o.select?.text !== undefined) declaration({ expr: o.select.expr, externalReason: o.select.externalReason, at: o.select.at }, o.name, rules);
                if (o.select?.externalReason !== undefined && !o.select.externalReason.trim())
                    rules.error('M028', `External check of outcome '${o.name}' needs a reason.`, o.select.at);
                if (o.select?.expr && o.select.externalReason !== undefined)
                    rules.error('M028', `Expression choice of outcome '${o.name}' cannot have an external check annotation.`, o.select.at);
                for (const emitted of o.emits)
                    if (emitted.when)
                        rules.error('M028', `Event '${emitted.event.text}' is already scoped to outcome '${o.name}'; remove 'when'.`, emitted.whenAt);
                const changedFields = new Set<string>();
                for (const change of o.changes) {
                    if (changedFields.has(change.name))
                        rules.error('M028', `Field '${change.name}' is listed more than once in outcome '${o.name}'.`, change.at);
                    changedFields.add(change.name);
                    const f = fields.find((x) => x.name === change.name);
                    if (!f && !statesOf(agg).some((s) => s.members.some((m) => 'name' in m && m.name === change.name)))
                        rules.error('M028', `Aggregate '${agg.name}' has no field '${change.name}' to change.`, change.at);
                    if (change.name === 'id') rules.error('M028', `Identity field 'id' cannot be changed by outcome '${o.name}'.`, change.at);
                    if (f?.readonly) rules.error('M028', `Readonly field '${change.name}' cannot be changed by outcome '${o.name}'.`, change.at);
                }
            }
        }
        for (const g of groups)
            for (const c of g.cases)
                for (const req of c.requirements) {
                    annotation(req, req.name, rules);
                    declaration(req, req.name, rules);
                }
        for (const f of fields.filter((x) => x.readonly)) {
            for (const cmd of commands.filter((x) => !x.factory)) {
                for (const change of cmd.changes.filter((x) => x.name === f.name))
                    rules.error('M028', `Readonly field '${f.name}' cannot be changed by command '${cmd.name}'.`, change.at);
            }
        }

        for (const kind of kinds) {
            const selected = groups.filter((g) => g.values.some((v) => v.value === kind));
            const initial = new Set([...commonInitials, ...selected.flatMap((g) => g.initials.map((i) => i.state.text))]);
            if (!initial.size) rules.error('M028', `Lifecycle kind '${kind}' of '${agg.name}' has no initial state.`, groups[0]?.at ?? agg.nameAt);
            const reachable = new Set(initial);
            const applicable = (cmd: CommandDecl): OutcomeDecl[] => [
                ...cmd.outcomes,
                ...selected.flatMap((g) => g.cases.filter((c) => c.command.text === cmd.name).flatMap((c) => c.outcomes)),
            ];
            let changed = true;
            while (changed) {
                changed = false;
                for (const cmd of commands.filter((c) => !c.factory)) {
                    for (const t of cmd.transitions.filter((t) => t.to.length === 1))
                        if (t.from.some((f) => reachable.has(f.text)) && !reachable.has(t.to[0]!.text)) {
                            reachable.add(t.to[0]!.text);
                            changed = true;
                        }
                    for (const o of applicable(cmd))
                        if (o.from.some((f) => reachable.has(f.text)) && !reachable.has(o.to.text)) {
                            reachable.add(o.to.text);
                            changed = true;
                        }
                }
            }
            for (const cmd of commands) {
                const outcomes = applicable(cmd);
                for (const o of outcomes) {
                    if (cmd.factory && !initial.has(o.to.text))
                        rules.error('M028', `Create outcome '${o.name}' must end at an initial state for kind '${kind}'.`, o.to.at);
                    if (!cmd.factory)
                        for (const source of o.from)
                            if (!reachable.has(source.text))
                                rules.error('M028', `Source state '${source.text}' of outcome '${o.name}' is unreachable for kind '${kind}'.`, source.at);
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
                                `Outcome '${o.name}' needs a select rule because '${cmd.name}' has multiple outcomes from '${source}' for kind '${kind}'.`,
                                o.nameAt,
                            );
                }
            }
        }
        for (const cmd of newCommands) {
            if (cmd.transitions.length || cmd.changes.length || cmd.emits.length)
                rules.error('M028', `Command '${cmd.name}' mixes named outcomes with legacy transitions, changes or emits.`, cmd.nameAt);
            if (!byCommand.get(cmd)?.length) rules.error('M028', `Command '${cmd.name}' has no outcomes.`, cmd.nameAt);
        }
    }
}
