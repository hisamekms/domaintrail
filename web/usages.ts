import type { DomainModel, FieldModel } from '../src/model/model';

export interface Usage {
    key: string;
    /** Element, state or command to select. */
    target: string;
    /** Context in which the type is used. */
    context: string;
    text: string;
}

type Named = { name: string; label?: string };
const englishName = (x: Named): string => x.name;

/** Where a type is used: fields of elements and states, and command parameters. `name` formats each part. */
export function usagesOf(model: DomainModel, id: string, name: (x: Named) => string = englishName): Usage[] {
    const uses: Usage[] = [];
    const typed = (f: FieldModel) => f.type.kind === 'ref' && f.type.ref === id;
    for (const el of Object.values(model.elements)) {
        for (const f of el.fields.filter(typed)) uses.push({ key: `${el.id}.${f.name}`, target: el.id, context: el.context, text: `${name(el)}.${name(f)}` });
        for (const s of el.states ?? []) {
            for (const f of s.fields.filter(typed)) {
                uses.push({ key: `${s.id}.${f.name}`, target: s.id, context: el.context, text: `${name(el)}.${name(s)}.${name(f)}` });
            }
        }
        for (const c of el.commands ?? []) {
            for (const p of c.params.filter(typed)) {
                uses.push({ key: `${c.id}.${p.name}`, target: c.id, context: el.context, text: `${name(el)}.${name(c)}(${name(p)})` });
            }
        }
    }
    return uses;
}
