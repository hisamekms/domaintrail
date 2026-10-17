import type { DiagnosticSink } from '../diagnostics.js';
import { discriminatorOf, fieldsOf, type ModelIndex } from '../model-index.js';

/**
 * M015: unions.
 *   - a union has at least one variant
 *   - with `by name: Enum`, the variants are exactly the enum's values
 *   - no variant field is named like the discriminator
 */
export function checkUnions(index: ModelIndex, sink: DiagnosticSink): void {
    for (const u of index.unions) {
        if (u.variants.length === 0) {
            sink.error('M015', `Union '${u.name}' must declare at least one variant.`, u, 'name');
            continue;
        }
        const tag = discriminatorOf(u);
        for (const v of u.variants) {
            for (const f of fieldsOf(v.members)) {
                if (f.name === tag) {
                    sink.error('M015', `Field '${f.name}' of variant '${u.name}.${v.name}' collides with the discriminator '${tag}'.`, f, 'name');
                }
            }
        }
        const bound = u.tagType?.ref;
        if (!bound) continue; // no binding, or unresolved (M001)
        const values = new Set(bound.values.map((v) => v.name));
        for (const v of u.variants) {
            if (!values.has(v.name)) {
                sink.error('M015', `Variant '${v.name}' of union '${u.name}' is not a value of enum '${bound.name}'.`, v, 'name');
            }
        }
        const declared = new Set(u.variants.map((v) => v.name));
        const missing = bound.values.filter((v) => !declared.has(v.name)).map((v) => `'${v.name}'`);
        if (missing.length) {
            sink.error('M015', `Union '${u.name}' is bound to enum '${bound.name}' but has no variant for ${missing.join(', ')}.`, u, 'name');
        }
    }
}
