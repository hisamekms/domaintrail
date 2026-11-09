import { commandsOf, emittedEventsInAggregate, fieldSetsOf, fieldsOf, ownFields, statesOf, variantsOf } from './model.js';
import type { AggregateModel, CommandModel, ContextName, DomainModel, ElementModel, FieldModel, QualifiedName } from './model.js';

/** Something with a name and a Japanese name: an element, state, variant, command or field. */
export type Named = { readonly name: string; readonly label?: string };

/** A field or parameter typed with an element. */
export interface FieldUse {
    key: string;
    /** Element, state or command that holds the field (its stable ID). */
    target: string;
    /** Context in which the type is used. */
    context: ContextName;
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
    const typed = (f: FieldModel): boolean => f.type.kind === 'ref' && f.type.ref === id;
    for (const el of model.elements) {
        const use = (key: string, target: string, field: FieldModel, path: Named[]): number => uses.push({ key, target, context: el.context, field, path });
        for (const f of ownFields(el).filter(typed)) use(`${el.id}.${f.name}`, el.id, f, [el]);
        for (const s of statesOf(el)) for (const f of s.fields.filter(typed)) use(`${s.id}.${f.name}`, s.id, f, [el, s]);
        for (const v of variantsOf(el)) for (const f of v.fields.filter(typed)) use(`${el.id}.${v.name}.${f.name}`, el.id, f, [el, v]);
        for (const c of commandsOf(el)) for (const p of c.params.filter(typed)) use(`${c.id}.${p.name}`, c.id, p, [el, c]);
    }
    return uses;
}

/** `Order.items`, `Order.Cancelled.reason`, `Order.addItem(item)`, with `name` formatting each part. */
export function fieldUseText(u: FieldUse, name: (x: Named) => string): string {
    const parts = u.path.map(name);
    return u.field.kind === 'param' ? `${parts.join('.')}(${name(u.field)})` : [...parts, name(u.field)].join('.');
}

/** Commands that emit the event or return the error `id`. */
export function commandsWithOutcome(model: DomainModel, id: string): { agg: AggregateModel; command: CommandModel }[] {
    return model.elements.flatMap((agg) =>
        agg.kind === 'aggregate'
            ? agg.commands.filter((c) => emittedEventsInAggregate(agg, c).some((e) => e === id) || c.errors.some((e) => e === id)).map((command) => ({ agg, command }))
            : [],
    );
}

/** Elements that take on the fields of a field set (`with`). */
export const fieldSetUsers = (model: DomainModel, id: string): ElementModel[] => model.elements.filter((e) => fieldSetsOf(e).some((f) => f === id));

/** The ID type of an aggregate or entity (the type of its `id` field), if it has one. */
export function identityOf(el: ElementModel): QualifiedName | undefined {
    const id = fieldsOf(el).find((f) => f.name === 'id');
    return id?.type.kind === 'ref' ? id.type.ref : undefined;
}
