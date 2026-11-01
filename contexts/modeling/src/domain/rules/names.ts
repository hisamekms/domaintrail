import type { RuleSink } from '../diagnostics.js';
import {
    commandsOf,
    commonFields,
    duplicates,
    fieldsOf,
    invariantsOf,
    statesOf,
    type AggregateDecl,
    type Declared,
    type SourceModel,
} from '../source-model.js';

/** M002: names are unique within their scope. */
export function checkNames(model: SourceModel, rules: RuleSink): void {
    for (const dups of duplicates(model)) {
        const [first, ...rest] = dups;
        for (const d of rest) {
            rules.error('M002', `'${first.context}.${d.name}' is already declared in context '${first.context}'.`, d.nameAt);
        }
    }

    for (const el of model.elements) {
        if (el.kind === 'aggregate') {
            checkAggregate(el, rules);
        } else if (el.kind === 'enum') {
            unique(el.values, (v) => `Enum value '${v.name}' is declared more than once in '${el.name}'.`, rules);
        } else if (el.kind === 'union') {
            unique(el.variants, (v) => `Variant '${v.name}' is declared more than once in '${el.name}'.`, rules);
            for (const v of el.variants) {
                unique(fieldsOf(v.members), (f) => `Field '${f.name}' is declared more than once in variant '${el.name}.${v.name}'.`, rules);
                unique(invariantsOf(v.members), (i) => `Invariant '${i.name}' is declared more than once in variant '${el.name}.${v.name}'.`, rules);
            }
        } else if ('members' in el) {
            const members = el.members;
            unique(fieldsOf(members), (f) => `Field '${f.name}' is declared more than once in '${el.name}'.`, rules);
            unique(invariantsOf(members), (i) => `Invariant '${i.name}' is declared more than once in '${el.name}'.`, rules);
        }
    }
}

function checkAggregate(agg: AggregateDecl, rules: RuleSink): void {
    const common = commonFields(agg);
    unique(common, (f) => `Field '${f.name}' is declared more than once in '${agg.name}'.`, rules);
    const commonNames = new Set(common.map((f) => f.name));

    const states = statesOf(agg);
    unique(states, (s) => `State '${s.name}' is declared more than once in '${agg.name}'.`, rules);
    for (const s of states) {
        const fields = fieldsOf(s.members);
        unique(fields, (f) => `Field '${f.name}' is declared more than once in state '${s.name}'.`, rules);
        for (const f of fields) {
            if (commonNames.has(f.name)) {
                rules.error('M002', `Field '${f.name}' of state '${s.name}' shadows the common field of '${agg.name}'.`, f.nameAt);
            }
        }
    }

    const invariants = [...invariantsOf(agg.members), ...states.flatMap((s) => invariantsOf(s.members))];
    unique(invariants, (i) => `Invariant '${i.name}' is declared more than once in '${agg.name}'.`, rules);

    const commands = commandsOf(agg);
    unique(commands, (c) => `Command '${c.name}' is declared more than once in '${agg.name}'.`, rules);
    for (const c of commands) {
        unique(c.params, (p) => `Parameter '${p.name}' is declared more than once in command '${c.name}'.`, rules);
        unique(c.requirements, (r) => `Requirement '${r.name}' is declared more than once in command '${c.name}'.`, rules);
        const names = c.changes.map((ch) => ch.name);
        c.changes.forEach((ch, i) => {
            if (names.indexOf(ch.name) < i) rules.error('M002', `Field '${ch.name}' is listed more than once in 'changes' of command '${c.name}'.`, ch.at);
        });
    }
}

function unique<T extends Declared>(items: readonly T[], message: (dup: T) => string, rules: RuleSink): void {
    const seen = new Set<string>();
    for (const item of items) {
        if (!item.name) continue;
        if (seen.has(item.name)) rules.error('M002', message(item), item.nameAt);
        seen.add(item.name);
    }
}
