import type { DomainModel } from '@domaintrail/modeling/model/model';
import { fieldUses, fieldUseText, type Named } from '@domaintrail/modeling/model/usages';

export interface Usage {
    key: string;
    /** Element, state or command to select. */
    target: string;
    /** Context in which the type is used. */
    context: string;
    text: string;
}

const englishName = (x: Named): string => x.name;

/**
 * Where a type is used: fields of elements, states and union variants, and command parameters. `name` formats each part.
 * A field of a field set counts once, in the field set, however many elements take it on.
 */
export function usagesOf(model: DomainModel, id: string, name: (x: Named) => string = englishName): Usage[] {
    return fieldUses(model, id).map((u) => ({ key: u.key, target: u.target, context: u.context, text: fieldUseText(u, name) }));
}
