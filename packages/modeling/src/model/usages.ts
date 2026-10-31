import { emittedEvents, ownFields, type CommandModel, type DomainModel, type ElementModel, type FieldModel } from './model.js';

/** Something with a name and a Japanese name: an element, state, variant, command or field. */
export type Named = { name: string; label?: string };

/** A field or parameter typed with an element. */
export interface FieldUse {
    key: string;
    /** Element, state or command that holds the field. */
    target: string;
    /** Context in which the type is used. */
    context: string;
    field: FieldModel;
    /** Where the field is: the element, then the state, variant or command (a command's field is a parameter). */
    path: Named[];
}

/**
 * Fields of elements, states and union variants, and command parameters, typed with `id` (`references` included: their
 * type is the target's ID). A field of a field set counts once, in the field set, however many elements take it on.
 */
export function fieldUses(model: DomainModel, id: string): FieldUse[] {
    const uses: FieldUse[] = [];
    const typed = (f: FieldModel) => f.type.kind === 'ref' && f.type.ref === id;
    for (const el of Object.values(model.elements)) {
        const use = (key: string, target: string, field: FieldModel, path: Named[]) => uses.push({ key, target, context: el.context, field, path });
        for (const f of ownFields(el).filter(typed)) use(`${el.id}.${f.name}`, el.id, f, [el]);
        for (const s of el.states ?? []) for (const f of s.fields.filter(typed)) use(`${s.id}.${f.name}`, s.id, f, [el, s]);
        for (const v of el.variants ?? []) for (const f of v.fields.filter(typed)) use(`${el.id}.${v.name}.${f.name}`, el.id, f, [el, v]);
        for (const c of el.commands ?? []) for (const p of c.params.filter(typed)) use(`${c.id}.${p.name}`, c.id, p, [el, c]);
    }
    return uses;
}

/** `Order.items`, `Order.Cancelled.reason`, `Order.addItem(item)`, with `name` formatting each part. */
export function fieldUseText(u: FieldUse, name: (x: Named) => string): string {
    const parts = u.path.map(name);
    return u.field.kind === 'param' ? `${parts.join('.')}(${name(u.field)})` : [...parts, name(u.field)].join('.');
}

/** Commands that emit the event or return the error `id`. */
export function commandsWithOutcome(model: DomainModel, id: string): { agg: ElementModel; command: CommandModel }[] {
    return Object.values(model.elements).flatMap((agg) =>
        (agg.commands ?? []).filter((c) => emittedEvents(c).includes(id) || c.errors.includes(id)).map((command) => ({ agg, command })),
    );
}

/** Elements that take on the fields of a field set (`with`). */
export const fieldSetUsers = (model: DomainModel, id: string): ElementModel[] => Object.values(model.elements).filter((e) => e.fieldSets?.includes(id));

/** The ID type of an aggregate or entity (the type of its `id` field), if it has one. */
export function identityOf(el: ElementModel): string | undefined {
    const id = el.fields.find((f) => f.name === 'id');
    return id?.type.kind === 'ref' ? id.type.ref : undefined;
}
