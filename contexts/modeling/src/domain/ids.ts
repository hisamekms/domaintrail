/**
 * Stable IDs are derived from fully qualified names so that they survive re-parsing:
 *   context        Sales
 *   element        Sales.Order
 *   state          Sales.Order#Confirmed
 *   command        Sales.Order:confirm
 *   kind           Sales.Order/Store
 *   field          Sales.Order.items
 *   state field    Sales.Order#Confirmed.confirmedAt
 *   invariant      Sales.Order.invariant.hasItems
 *   on case        Sales.Order/Store:on:finish
 *   parameter      Sales.Order:confirm(reason)
 *   function       Sales.discounted
 *   function param Sales.discounted(amount)
 *   requirement    Sales.Order:confirm.requires.authorized
 *   outcome        Sales.Order:confirm->approved
 *   variant        Sales.Payment|card
 *   variant field  Sales.Payment|card.last4
 *
 * Names are DSL identifiers and cannot contain the separators used here. M002 makes fields unique among fields and
 * invariants among invariants, but permits a field and invariant to share a name, so invariant IDs carry a category
 * marker. Parameters, requirements and outcomes have separate owner namespaces; their readable forms cannot collide.
 * A function has the form of an element (both are declared at context level, and M002 keeps their names apart), so
 * `parseSemanticId` reads it as `element`; its parameters, as a command's, as `parameter`.
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
export const kindId = (aggregateId: string, kind: string): ElementId => as<ElementId>(`${aggregateId}/${kind}`);
export type DeclarationId = string & { readonly __declarationId: unique symbol };
export const fieldId = (ownerId: string, field: string): DeclarationId => as<DeclarationId>(`${ownerId}.${field}`);
export const parameterId = (command: string, parameter: string): DeclarationId => as<DeclarationId>(`${command}(${parameter})`);
/** A function of a context: `Sales.discounted`. */
export const functionId = (context: string, name: string): DeclarationId => as<DeclarationId>(`${context}.${name}`);

/** `changes x = …` of an outcome (or of a shorthand command): `Sales.Order:confirm->confirmed.changes.confirmedAt`. */
export const changeId = (ownerId: string, field: string): DeclarationId => as<DeclarationId>(`${ownerId}.changes.${field}`);

/** `ensures { … }` of an outcome (or of a shorthand command). */
export const ensuresId = (ownerId: string): DeclarationId => as<DeclarationId>(`${ownerId}.ensures`);

/**
 * The frame condition of an outcome for a field it does not list in `changes` (ADR 0043): a carried field stays
 * `before.x`, an optional field the outcome makes exist stays absent. `Sales.Order:confirm->confirmed.unchanged.note`.
 */
export const unchangedId = (outcomeId: string, field: string): DeclarationId => as<DeclarationId>(`${outcomeId}.unchanged.${field}`);

export const invariantId = (ownerId: string, invariant: string): DeclarationId => as<DeclarationId>(`${ownerId}.invariant.${invariant}`);
export const requirementId = (command: string, requirement: string): DeclarationId => as<DeclarationId>(`${command}.requires.${requirement}`);
export const outcomeId = (command: string, outcome: string): DeclarationId => as<DeclarationId>(`${command}->${outcome}`);
/** Stable ID for a shorthand transition outcome, or `*` for a stateless command. */
export const shorthandOutcomeId = (command: string, target: string | undefined): DeclarationId => as<DeclarationId>(`${command}->${target ?? '*'}`);
export const variantId = (unionId: string, variant: string): DeclarationId => as<DeclarationId>(`${unionId}|${variant}`);
export const enumValueId = (enumeration: string, value: string): DeclarationId => as<DeclarationId>(`${enumeration}=${value}`);
export const onCaseId = (kind: string, command: string): DeclarationId => as<DeclarationId>(`${kind}:on:${command}`);

export type SemanticIdCategory =
    | 'context'
    | 'element'
    | 'state'
    | 'command'
    | 'kind'
    | 'field'
    | 'invariant'
    | 'onCase'
    | 'parameter'
    | 'requirement'
    | 'outcome'
    | 'variant'
    | 'variantField'
    | 'enumValue';

/** Parse the categories emitted by this module; malformed or ambiguous text is not accepted. */
export function parseSemanticId(id: string): { category: SemanticIdCategory; id: string } | undefined {
    const patterns: [SemanticIdCategory, RegExp][] = [
        ['invariant', /^.+\.invariant\.[^.]+$/],
        ['requirement', /^.+\.requires\.[^.]+$/],
        ['onCase', /^.+\/[^/:]+:on:[^/:]+$/],
        ['outcome', /^.+:[^:]+->[^:]+$/],
        ['parameter', /^.+:[^(]+\([^)]+\)$/],
        // a function's parameter: `Sales.discounted(amount)`
        ['parameter', /^[^.:]+\.[^.:()]+\([^)]+\)$/],
        ['enumValue', /^.+=[^=]+$/],
        ['variantField', /^.+\|[^.|]+\.[^.]+$/],
        ['variant', /^.+\|[^.|]+$/],
        ['state', /^.+#[^.#]+$/],
        ['kind', /^.+\/[^/.]+$/],
        ['command', /^.+:[^:()]+$/],
        ['element', /^[^.]+\.[^.]+$/],
        ['context', /^[^.]+$/],
    ];
    const match = patterns.find(([, pattern]) => pattern.test(id));
    if (!match && /^.+\.[^.]+$/.test(id)) return { category: 'field', id };
    return match ? { category: match[0], id } : undefined;
}
/** The qualified name of an element (`Sales.Order`); a reference as written when it does not resolve. */
export const qualifiedName = (text: string): QualifiedName => as<QualifiedName>(text);
/** The stable ID of the element a qualified name names (the same text). */
export const idOfName = (qname: QualifiedName): ElementId => as<ElementId>(qname);
/** The qualified name of an element, from its stable ID (the same text). */
export const nameOfId = (id: ElementId): QualifiedName => as<QualifiedName>(id);
