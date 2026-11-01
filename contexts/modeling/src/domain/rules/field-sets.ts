import type { RuleSink } from '../diagnostics.js';
import { commonFields, fieldsOf, includedFields, statesOf, type FieldDecl, type SourceModel, type WithFieldSets } from '../source-model.js';

/**
 * M016: field sets (`fields Name { ... }`) and `with`.
 *   - only aggregates, entities and events take field sets; a field set does not include others
 *   - a field set holds plain fields only (no `owns`, `references` or invariants), and no `id`: identity is declared
 *     by each aggregate and entity itself (M013)
 *   - a field name comes from one place only: the element itself or one of its field sets
 * Unresolved field sets are reported from linking, also as M016.
 */
export function checkFieldSets(model: SourceModel, rules: RuleSink): void {
    for (const fs of model.elements) {
        if (fs.kind !== 'fieldSet') continue;
        for (const m of fs.members) {
            if (m.kind === 'invariant') {
                rules.error('M016', `Field set '${fs.name}' cannot hold invariants; write invariant '${m.name}' in the elements that use it.`, m.nameAt);
            } else if (m.kind === 'owns' || m.kind === 'references') {
                const hint = `declare '${m.name}' in each element that uses '${fs.name}', or make it a plain field`;
                rules.error('M016', `A field set holds plain fields only; '${m.name}' is declared with '${m.kind}'.`, m.nameAt, hint);
            } else if (m.name === 'id') {
                const hint = `remove 'id' from '${fs.name}' and declare it in each aggregate and entity with an ID type of its own`;
                rules.error(
                    'M016',
                    `Field set '${fs.name}' cannot declare 'id'; the identity is declared by each aggregate and entity itself.`,
                    m.nameAt,
                    hint,
                );
            }
        }
    }

    for (const el of model.elements) {
        if (!('fieldSets' in el) || el.fieldSets.length === 0) continue;
        if (el.kind === 'fieldSet' || el.kind === 'valueObject' || el.kind === 'error') {
            const what =
                el.kind === 'fieldSet'
                    ? `field set '${el.name}' cannot include other field sets`
                    : `${el.kind === 'valueObject' ? 'value object' : 'error'} '${el.name}' cannot take field sets`;
            const hint =
                el.kind === 'fieldSet'
                    ? `list the field sets on the elements that use '${el.name}' instead`
                    : `remove 'with' and declare the fields in '${el.name}'`;
            rules.error('M016', `'with' is only for aggregates, entities and events; ${what}.`, el.fieldSets[0]!.at, hint);
            continue;
        }
        checkUses(el, rules);
    }
}

function checkUses(el: WithFieldSets, rules: RuleSink): void {
    const seen = new Set<unknown>();
    for (const r of el.fieldSets) {
        if (!r.target) continue;
        if (seen.has(r.target)) rules.warning('M016', `Field set '${r.text}' is listed more than once.`, r.at);
        seen.add(r.target);
    }

    // where each included field comes from: the first field set that declares it
    const from = new Map<string, string>();
    for (const { field, fieldSet } of includedFields(el)) {
        const first = from.get(field.name);
        if (first === undefined) {
            from.set(field.name, fieldSet.name);
        } else if (first !== fieldSet.name) {
            const at = el.fieldSets.find((r) => r.target === fieldSet)!.at;
            const hint = `remove '${field.name}' from one of the two field sets, or take only one of them in '${el.name}'`;
            rules.error(
                'M016',
                `Field '${field.name}' of field set '${fieldSet.name}' is also declared in field set '${first}', both used by '${el.name}'.`,
                at,
                hint,
            );
        }
    }

    const own: FieldDecl[] = el.kind === 'aggregate' ? commonFields(el) : fieldsOf(el.members);
    for (const f of own) {
        const fs = from.get(f.name);
        if (fs)
            rules.error(
                'M016',
                `Field '${f.name}' of '${el.name}' is already taken from field set '${fs}'.`,
                f.nameAt,
                `remove the field here, or rename it if it means something else`,
            );
    }
    if (el.kind === 'aggregate') {
        for (const s of statesOf(el)) {
            for (const f of fieldsOf(s.members)) {
                const fs = from.get(f.name);
                if (fs)
                    rules.error(
                        'M016',
                        `Field '${f.name}' of state '${s.name}' shadows the field of field set '${fs}' in '${el.name}'.`,
                        f.nameAt,
                        `remove the field from the state, or rename it`,
                    );
            }
        }
    }
}
