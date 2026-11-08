// The stable ID (`domain/ids.ts`) of the model element an AST node lies in: for the sites of the model as written, the
// diagnostics of the links, and the language server.
import type { AstNode } from 'langium';
import {
    isCommand,
    isContext,
    isContextElement,
    isState,
    type Aggregate,
    type Command,
    type Context,
    type ContextElement,
    type State,
} from './generated/ast.js';
import { commandId, contextId, elementId, stateId } from '../../domain/ids.js';

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
