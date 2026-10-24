import type { AstNode } from 'langium';
import { isCommand, isContext, isContextElement, isState, type Aggregate, type Command, type Context, type ContextElement, type State } from '../language/generated/ast.js';

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

/** Returns the stable ID of the closest model element containing `node`. */
export function elementIdOf(node: AstNode | undefined): string | undefined {
    let n: AstNode | undefined = node;
    while (n) {
        if (isState(n)) {
            const s = n as State;
            return stateId(idOfContextElement(s.$container), s.name);
        }
        if (isCommand(n)) {
            const c = n as Command;
            return commandId(idOfContextElement(c.$container), c.name);
        }
        if (n.$type === 'Terms' && n.$container && isContext(n.$container)) {
            return contextId((n.$container as Context).name);
        }
        if (n.$container && isContext(n.$container)) {
            if (isContextElement(n)) return idOfContextElement(n);
        }
        if (isContext(n)) return contextId((n as Context).name);
        n = n.$container;
    }
    return undefined;
}

function idOfContextElement(el: ContextElement | Aggregate): string {
    return elementId(el.$container.name, el.name);
}
