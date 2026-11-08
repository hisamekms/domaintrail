/**
 * Stable IDs are derived from fully qualified names so that they survive re-parsing:
 *   context        Sales
 *   element        Sales.Order
 *   state          Sales.Order#Confirmed
 *   command        Sales.Order:confirm
 * Renaming an element changes its ID (the layout for it is recomputed). The builders make the Typed Model's names and
 * IDs here, and only here.
 */
import type { ContextName, ElementId, QualifiedName } from '../generated/Modeling.js';

/** A text as one of the Typed Model's names and IDs (string types told apart by their name). */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place that makes the Typed Model's names and IDs from text
const as = <T extends string>(text: string): T => text as T;

export const contextId = (ctx: string): string => ctx;
export const contextName = (name: string): ContextName => as<ContextName>(name);
export const elementId = (ctx: string, name: string): ElementId => as<ElementId>(`${ctx}.${name}`);
export const stateId = (aggregateId: string, state: string): ElementId => as<ElementId>(`${aggregateId}#${state}`);
export const commandId = (aggregateId: string, command: string): ElementId => as<ElementId>(`${aggregateId}:${command}`);
/** The qualified name of an element (`Sales.Order`); a reference as written when it does not resolve. */
export const qualifiedName = (text: string): QualifiedName => as<QualifiedName>(text);
/** The stable ID of the element a qualified name names (the same text). */
export const idOfName = (qname: QualifiedName): ElementId => as<ElementId>(qname);
/** The qualified name of an element, from its stable ID (the same text). */
export const nameOfId = (id: ElementId): QualifiedName => as<QualifiedName>(id);
