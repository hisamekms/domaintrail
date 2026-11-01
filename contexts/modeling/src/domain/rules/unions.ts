import type { RuleSink } from '../diagnostics.js';
import { discriminatorOf, fieldsOf, type SourceModel, type UnionDecl } from '../source-model.js';
import { didYouMean } from '@domaintrail/kernel';

/**
 * M015: unions.
 *   - a union has at least one variant
 *   - with `by name: Enum`, the variants are exactly the enum's values
 *   - no variant field is named like the discriminator
 */
export function checkUnions(model: SourceModel, rules: RuleSink): void {
    for (const u of model.elements.filter((e): e is UnionDecl => e.kind === 'union')) {
        if (u.variants.length === 0) {
            rules.error('M015', `Union '${u.name}' must declare at least one variant.`, u.nameAt);
            continue;
        }
        const tag = discriminatorOf(u);
        for (const v of u.variants) {
            for (const f of fieldsOf(v.members)) {
                if (f.name === tag) {
                    const hint = `rename the field, or name another discriminator with 'union ${u.name} by <name>'`;
                    rules.error('M015', `Field '${f.name}' of variant '${u.name}.${v.name}' collides with the discriminator '${tag}'.`, f.nameAt, hint);
                }
            }
        }
        const bound = u.tagType?.target;
        if (!bound) continue; // no binding, or unresolved (M001)
        const values = new Set(bound.values.map((v) => v.name));
        for (const v of u.variants) {
            if (!values.has(v.name)) {
                const hint = didYouMean(v.name, [...values]) ?? `add '${v.name}' to enum '${bound.name}', or remove the variant`;
                rules.error('M015', `Variant '${v.name}' of union '${u.name}' is not a value of enum '${bound.name}'.`, v.nameAt, hint);
            }
        }
        const declared = new Set(u.variants.map((v) => v.name));
        const missing = bound.values.filter((v) => !declared.has(v.name)).map((v) => `'${v.name}'`);
        if (missing.length) {
            rules.error(
                'M015',
                `Union '${u.name}' is bound to enum '${bound.name}' but has no variant for ${missing.join(', ')}.`,
                u.nameAt,
                `add a variant for each missing value (a variant may have no fields)`,
            );
        }
    }
}
