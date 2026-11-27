import type { FieldDecl, SourceModel, UnionDecl, ValueObjectDecl } from './source-model.js';
import { fieldsOf, includedFields } from './source-model.js';
import { cardinality } from './types.js';

export interface ValueCycle {
    readonly members: readonly string[];
    readonly ending: ReadonlyMap<string, string>;
}

/** Recursive components in the graph used by generated value arbitraries. */
export function valueCycles(model: SourceModel): ValueCycle[] {
    const values = model.elements.filter((e): e is ValueObjectDecl | UnionDecl => e.kind === 'valueObject' || e.kind === 'union');
    const fields = (e: ValueObjectDecl | UnionDecl): FieldDecl[] =>
        e.kind === 'union' ? e.variants.flatMap((v) => fieldsOf(v.members)) : [...includedFields(e).map((i) => i.field), ...fieldsOf(e.members)];
    const parts = new Map(
        values.map((e) => [
            e.id,
            fields(e)
                .filter((f) => f.kind !== 'references')
                .flatMap((f) => {
                    const target = f.type?.decl?.target;
                    return target && (target.kind === 'valueObject' || target.kind === 'union') ? [target.id] : [];
                }),
        ]),
    );
    let nextIndex = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const components: string[][] = [];
    const visit = (id: string): void => {
        index.set(id, nextIndex);
        low.set(id, nextIndex++);
        stack.push(id);
        onStack.add(id);
        for (const next of parts.get(id) ?? []) {
            if (!index.has(next)) {
                visit(next);
                low.set(id, Math.min(low.get(id)!, low.get(next)!));
            } else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, index.get(next)!));
        }
        if (low.get(id) !== index.get(id)) return;
        const component: string[] = [];
        for (;;) {
            const item = stack.pop()!;
            onStack.delete(item);
            component.push(item);
            if (item === id) break;
        }
        components.push(component);
    };
    for (const id of parts.keys()) if (!index.has(id)) visit(id);
    const order = new Map(values.map((e, i) => [e.id, i]));
    return components.flatMap((component) => {
        if (component.length === 1 && !parts.get(component[0])!.includes(component[0])) return [];
        const members = component.sort((a, b) => order.get(a)! - order.get(b)!);
        const memberSet = new Set(members);
        const ended = new Set<string>();
        const ending = new Map<string, string>();
        const ends = (fs: readonly FieldDecl[]): boolean =>
            fs.every((f) => {
                if (f.kind === 'references') return true;
                const target = f.type?.decl?.target;
                if (!target || (target.kind !== 'valueObject' && target.kind !== 'union')) return true;
                return (
                    !memberSet.has(target.id) || cardinality(f.multiplicity) === 'optional' || cardinality(f.multiplicity) === 'many' || ended.has(target.id)
                );
            });
        let grew = true;
        while (grew) {
            grew = false;
            for (const id of members) {
                if (ended.has(id)) continue;
                const el = values.find((e) => e.id === id)!;
                const variant = el.kind === 'union' ? el.variants.find((v) => ends(fieldsOf(v.members))) : undefined;
                if (el.kind === 'union' ? !variant : !ends(fields(el))) continue;
                if (variant) ending.set(id, variant.name);
                ended.add(id);
                grew = true;
            }
        }
        return [{ members, ending }];
    });
}
