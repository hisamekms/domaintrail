import { isAggregate, isEntity, isErrorDecl, isEventDecl, isFieldSet, isInvariant, isOwnsField, isReferenceField, isValueObject } from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commonFields, fieldsOf, includedFields, statesOf, type FieldLike, type ModelIndex, type WithFieldSets } from '../model-index.js';

/**
 * M016: field sets (`fields Name { ... }`) and `with`.
 *   - only aggregates, entities and events take field sets; a field set does not include others
 *   - a field set holds plain fields only (no `owns`, `references` or invariants), and no `id`: identity is declared
 *     by each aggregate and entity itself (M013)
 *   - a field name comes from one place only: the element itself or one of its field sets
 * Unresolved field sets are reported from linking, also as M016.
 */
export function checkFieldSets(index: ModelIndex, sink: DiagnosticSink): void {
    for (const fs of index.fieldSets) {
        for (const m of fs.members) {
            if (isInvariant(m)) {
                sink.error('M016', `Field set '${fs.name}' cannot hold invariants; write invariant '${m.name}' in the elements that use it.`, m, 'name');
            } else if (isOwnsField(m) || isReferenceField(m)) {
                const keyword = isOwnsField(m) ? 'owns' : 'references';
                sink.error('M016', `A field set holds plain fields only; '${m.name}' is declared with '${keyword}'.`, m, 'name');
            } else if (m.name === 'id') {
                sink.error('M016', `Field set '${fs.name}' cannot declare 'id'; the identity is declared by each aggregate and entity itself.`, m, 'name');
            }
        }
    }

    for (const el of index.elements) {
        if (!('fieldSets' in el) || el.fieldSets.length === 0) continue;
        if (isFieldSet(el) || isValueObject(el) || isErrorDecl(el)) {
            const what = isFieldSet(el) ? `field set '${el.name}' cannot include other field sets` : `${isValueObject(el) ? 'value object' : 'error'} '${el.name}' cannot take field sets`;
            sink.error('M016', `'with' is only for aggregates, entities and events; ${what}.`, el, 'fieldSets');
            continue;
        }
        if (isAggregate(el) || isEntity(el) || isEventDecl(el)) checkUses(el, sink);
    }
}

function checkUses(el: WithFieldSets, sink: DiagnosticSink): void {
    const seen = new Set<unknown>();
    el.fieldSets.forEach((r, i) => {
        if (!r.ref) return;
        if (seen.has(r.ref)) sink.warning('M016', `Field set '${r.$refText}' is listed more than once.`, el, 'fieldSets', i);
        seen.add(r.ref);
    });

    // where each included field comes from: the first field set that declares it
    const from = new Map<string, string>();
    for (const { field, fieldSet } of includedFields(el)) {
        const first = from.get(field.name);
        if (first === undefined) {
            from.set(field.name, fieldSet.name);
        } else if (first !== fieldSet.name) {
            const at = el.fieldSets.findIndex((r) => r.ref === fieldSet);
            sink.error('M016', `Field '${field.name}' of field set '${fieldSet.name}' is also declared in field set '${first}', both used by '${el.name}'.`, el, 'fieldSets', at);
        }
    }

    const own: FieldLike[] = isAggregate(el) ? commonFields(el) : fieldsOf(el.members);
    for (const f of own) {
        const fs = from.get(f.name);
        if (fs) sink.error('M016', `Field '${f.name}' of '${el.name}' is already taken from field set '${fs}'.`, f, 'name');
    }
    if (isAggregate(el)) {
        for (const s of statesOf(el)) {
            for (const f of fieldsOf(s.members)) {
                const fs = from.get(f.name);
                if (fs) sink.error('M016', `Field '${f.name}' of state '${s.name}' shadows the field of field set '${fs}' in '${el.name}'.`, f, 'name');
            }
        }
    }
}
