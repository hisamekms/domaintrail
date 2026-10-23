import type { AstNode } from 'langium';
import { isAggregate, isEnumDecl, isUnionDecl, type Aggregate } from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, commonFields, fieldsOf, invariantsOf, statesOf, type ModelIndex } from '../model-index.js';

/** M002: names are unique within their scope. */
export function checkNames(index: ModelIndex, sink: DiagnosticSink): void {
    for (const dups of index.duplicates()) {
        const [first, ...rest] = dups;
        for (const d of rest) {
            sink.error('M002', `'${first.$container.name}.${d.name}' is already declared in context '${first.$container.name}'.`, d, 'name');
        }
    }

    for (const el of index.elements) {
        if (isAggregate(el)) {
            checkAggregate(el, sink);
        } else if (isEnumDecl(el)) {
            unique(el.values, (v) => `Enum value '${v.name}' is declared more than once in '${el.name}'.`, sink);
        } else if (isUnionDecl(el)) {
            unique(el.variants, (v) => `Variant '${v.name}' is declared more than once in '${el.name}'.`, sink);
            for (const v of el.variants) {
                unique(fieldsOf(v.members), (f) => `Field '${f.name}' is declared more than once in variant '${el.name}.${v.name}'.`, sink);
                unique(invariantsOf(v.members), (i) => `Invariant '${i.name}' is declared more than once in variant '${el.name}.${v.name}'.`, sink);
            }
        } else if ('members' in el) {
            const members = el.members;
            unique(fieldsOf(members), (f) => `Field '${f.name}' is declared more than once in '${el.name}'.`, sink);
            unique(invariantsOf(members), (i) => `Invariant '${i.name}' is declared more than once in '${el.name}'.`, sink);
        }
    }
}

function checkAggregate(agg: Aggregate, sink: DiagnosticSink): void {
    const common = commonFields(agg);
    unique(common, (f) => `Field '${f.name}' is declared more than once in '${agg.name}'.`, sink);
    const commonNames = new Set(common.map((f) => f.name));

    const states = statesOf(agg);
    unique(states, (s) => `State '${s.name}' is declared more than once in '${agg.name}'.`, sink);
    for (const s of states) {
        const fields = fieldsOf(s.members);
        unique(fields, (f) => `Field '${f.name}' is declared more than once in state '${s.name}'.`, sink);
        for (const f of fields) {
            if (commonNames.has(f.name)) {
                sink.error('M002', `Field '${f.name}' of state '${s.name}' shadows the common field of '${agg.name}'.`, f, 'name');
            }
        }
    }

    const invariants = [...invariantsOf(agg.members), ...states.flatMap((s) => invariantsOf(s.members))];
    unique(invariants, (i) => `Invariant '${i.name}' is declared more than once in '${agg.name}'.`, sink);

    const commands = commandsOf(agg);
    unique(commands, (c) => `Command '${c.name}' is declared more than once in '${agg.name}'.`, sink);
    for (const c of commands) {
        unique(c.params, (p) => `Parameter '${p.name}' is declared more than once in command '${c.name}'.`, sink);
        unique(c.requirements, (r) => `Requirement '${r.name}' is declared more than once in command '${c.name}'.`, sink);
        c.changes.forEach((name, i) => {
            if (c.changes.indexOf(name) < i) sink.error('M002', `Field '${name}' is listed more than once in 'changes' of command '${c.name}'.`, c, 'changes', i);
        });
    }
}

function unique<T extends AstNode & { name: string }>(items: readonly T[], message: (dup: T) => string, sink: DiagnosticSink): void {
    const seen = new Set<string>();
    for (const item of items) {
        if (!item.name) continue;
        if (seen.has(item.name)) sink.error('M002', message(item), item, 'name');
        seen.add(item.name);
    }
}
