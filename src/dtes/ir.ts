/**
 * The Event Storming DSL (`.dtes`, docs/dtes-v0.1.md): the types shared by its parser, validator, `.dt` linker,
 * projection, CLI and Live View (ADR 0024). Three layers, kept apart (spec §7):
 *
 * - the **storming IR** (`Storming`, here): what a file says, as written — every clause in source order with its range,
 *   also the invalid ones, so that the validator reports from it and the formatter-independent tools need no AST;
 * - the **semantic graph** and the **render graph** (`src/visualization/domain/storming/ir.ts`): what the projection
 *   makes of it for the Live View.
 */
import type { Diagnostic, Position, RuleId, Severity } from '../core/diagnostics.js';

// ---- Storming IR ----

/** A span of a source file, 1-based like `Diagnostic` (the end column is exclusive). */
export interface SourceRange {
    /** Path as given to the analyzer (relative to the workspace root). */
    file: string;
    start: Position;
    end: Position;
}

/** The kinds of declarations; they share one namespace per storming (spec §2, §14). */
export type ElementKind = 'event' | 'actor' | 'external' | 'command' | 'policy' | 'aggregate' | 'readmodel' | 'hotspot' | 'timeline' | 'group';

/** The declarations drawn as nodes of their own (a timeline and a group are drawn through their events). */
export type NodeElementKind = Exclude<ElementKind, 'timeline' | 'group'>;

/** The keywords of a relation clause inside an element's body (spec §3.2). */
export type RelationKeyword = 'actor' | 'reads' | 'target' | 'emits' | 'on' | 'issues';

/**
 * A clause of an element's body, as written. The grammar accepts every clause in every body, so that a misplaced one is
 * reported by the validator with a message of its own rather than as a syntax error.
 */
export type Clause =
    /** `ref Delivery.Shipment.cancel`: the `.dt` symbol the element corresponds to (spec §5.1). */
    | { type: 'ref'; path: string; segments: string[]; range: SourceRange }
    /** `target Shipment`: a reference to another element of the same storming, by local ID. */
    | { type: 'relation'; keyword: RelationKeyword; target: string; range: SourceRange; targetRange: SourceRange }
    /** `status open`: the word as written (only `open` and `resolved` are valid). */
    | { type: 'status'; value: string; range: SourceRange }
    /** `resolution "..."`: the text without its quotes, escapes resolved. */
    | { type: 'resolution'; text: string; range: SourceRange };

interface Declaration {
    /** Local ID, unique in the storming across kinds. */
    id: string;
    /** The display name (the string after the ID); for a hotspot, its question. */
    label?: string;
    /** Description from `///` comments. */
    doc?: string;
    /** The whole declaration. */
    range: SourceRange;
    /** The ID after the keyword, where diagnostics about the declaration itself are reported. */
    nameRange: SourceRange;
}

/** `event`, `actor`, `external`, `command`, `policy`, `aggregate`, `readmodel` or `hotspot`, with its body's clauses. */
export interface NodeElement extends Declaration {
    kind: NodeElementKind;
    clauses: Clause[];
}

/** An event of a timeline, by ID (it should name an event; anything else is a kind error). */
export interface EventStepRef {
    eventId: string;
    range: SourceRange;
}

/** `group Id "label" { A B }`: events of one stage, without an order among them (spec §3.4). */
export interface Group extends Declaration {
    kind: 'group';
    events: EventStepRef[];
}

export type TimelineStep = ({ type: 'event' } & EventStepRef) | ({ type: 'group' } & Group);

/** A partial time order of events: event references and groups only (spec §3.4). */
export interface Timeline extends Declaration {
    kind: 'timeline';
    steps: TimelineStep[];
}

export type StormingElement = NodeElement | Timeline;

/** Any declaration of a storming, groups included. */
export type AnyDeclaration = NodeElement | Timeline | Group;

/** `storming Id "label" { ... }`: the unit of Event Storming. */
export interface Storming extends Declaration {
    /** Top-level declarations in source order (groups are inside their timelines). */
    elements: StormingElement[];
}

/** The stormings of a workspace as analyzed: the contract between the analyzer (ADR 0024, T6) and the Live View (T7). */
export interface StormingAnalysis {
    /** The `.dtes` files analyzed, as given to the analyzer. */
    files: string[];
    /** The stormings of every file that parses, in file order, then source order. */
    stormings: Storming[];
    /** Syntax, validation and `.dt` link diagnostics of the `.dtes` files. */
    diagnostics: Diagnostic[];
    /** True when every `.dtes` file parsed. */
    syntaxOk: boolean;
}

/** Every declaration of a storming, groups included, in source order. */
export function declarations(storming: Storming): AnyDeclaration[] {
    return storming.elements.flatMap((el): AnyDeclaration[] =>
        el.kind === 'timeline' ? [el, ...el.steps.filter((s): s is { type: 'group' } & Group => s.type === 'group')] : [el],
    );
}

// ---- Rules shared by the validator and the projection ----

/**
 * Which relation clauses each element kind takes, and the kinds their targets must have (spec §3.2, §5.1, §14).
 * A relation outside this table, or to a target of another kind, is invalid: reported by the validator, left out of
 * the semantic graph. Multiplicities are checked by the validator only.
 */
export const RELATION_RULES: Readonly<Partial<Record<NodeElementKind, Readonly<Partial<Record<RelationKeyword, readonly NodeElementKind[]>>>>>> = {
    command: { actor: ['actor', 'external'], reads: ['readmodel'], target: ['aggregate'], emits: ['event'] },
    policy: { on: ['event'], issues: ['command'] },
    hotspot: { on: ['event'] },
};

/** The element kinds that may have a `ref` to `.dt` (spec §5.1). */
export const REF_KINDS: readonly NodeElementKind[] = ['event', 'aggregate', 'command'];

// ---- IDs and diagnostics ----

/** Workspace-wide ID of a storming's element (diagnostics' `elementId`, the Live View's selection). */
export const esElementId = (stormingId: string, localId?: string): string => (localId === undefined ? `es/${stormingId}` : `es/${stormingId}/${localId}`);

/** A diagnostic at a range of a `.dtes` file. */
export function esDiagnostic(
    severity: Severity,
    code: RuleId,
    message: string,
    range: SourceRange,
    extra: { hint?: string; elementId?: string } = {},
): Diagnostic {
    return {
        file: range.file,
        start: range.start,
        end: range.end,
        severity,
        code,
        message,
        ...(extra.hint ? { hint: extra.hint } : {}),
        ...(extra.elementId ? { elementId: extra.elementId } : {}),
    };
}
