/**
 * Stable IDs are derived from fully qualified names so that they survive re-parsing:
 *   context        Sales
 *   element        Sales.Order
 *   state          Sales.Order#Confirmed
 *   command        Sales.Order:confirm
 * Renaming an element changes its ID (the layout for it is recomputed).
 */
export const contextId = (ctx: string): string => ctx;
export const elementId = (ctx: string, name: string): string => `${ctx}.${name}`;
export const stateId = (aggregateId: string, state: string): string => `${aggregateId}#${state}`;
export const commandId = (aggregateId: string, command: string): string => `${aggregateId}:${command}`;
