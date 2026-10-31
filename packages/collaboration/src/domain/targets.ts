// Whether the target of a request still resolves in a model (ADR 0026, ModelTarget): a target is never re-bound, so a
// path that no longer matches is shown as stale. Render node IDs are never involved: `.dt` elements are looked up by
// model ID, storming elements by storming and local ID, occurrences by timeline, event and step path.
import type { DomainModel } from '@domaintrail/modeling/model/model';
import { declarations, type Storming } from '@domaintrail/modeling/storming/ir';
import type { Collaboration } from '../generated/index.js';

/** What a target is resolved against: the analysis of one snapshot of the workspace. */
export interface TargetScope {
    /** The Typed Model; absent when the `.dt` sources do not parse. */
    readonly model: DomainModel | undefined;
    /** The stormings of the `.dtes` files that parse. */
    readonly stormings: readonly Storming[];
    /** Whether every `.dtes` file parsed: if not, a storming not found may be in a file that does not parse. */
    readonly stormingsComplete: boolean;
}

/** `current`: it resolves; `stale`: it no longer does; `unknown`: the sources it would be in do not parse. */
export type TargetStatus = 'current' | 'stale' | 'unknown';

/**
 * The text of an occurrence's step path (`EventOccurrence.stepPath` of the Live View, ADR 0026's appendix): the step's
 * index in the timeline, and for an event in a group its index in the group, joined by `.` (`3`, `2.1`).
 */
export const encodeOccurrencePath = (stepPath: readonly number[]): string => stepPath.join('.');

/** The step path of an occurrence's text, or `undefined` when it is not one (one or two non-negative integers). */
export function decodeOccurrencePath(text: string): number[] | undefined {
    if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/.test(text)) return undefined;
    return text.split('.').map(Number);
}

/** Whether a `.dt` model ID names something: an element, a state (`Sales.Order#Shipped`) or a command (`Sales.Order:confirm`). */
function modelIdResolves(model: DomainModel, id: string): boolean {
    if (model.elements[id]) return true;
    const state = id.lastIndexOf('#');
    if (state > 0) return model.elements[id.slice(0, state)]?.states?.some((s) => s.name === id.slice(state + 1)) ?? false;
    const command = id.lastIndexOf(':');
    if (command > 0) return model.elements[id.slice(0, command)]?.commands?.some((c) => c.name === id.slice(command + 1)) ?? false;
    return false;
}

/** Whether the occurrence at `stepPath` of a timeline is the event `eventId`. */
function occurrenceResolves(storming: Storming, timelineId: string, eventId: string, stepPath: readonly number[]): boolean {
    const timeline = storming.elements.find((el) => el.kind === 'timeline' && el.id === timelineId);
    if (timeline?.kind !== 'timeline') return false;
    const [i, j] = stepPath;
    const step = timeline.steps[i];
    if (step === undefined) return false;
    if (step.type === 'event') return stepPath.length === 1 && step.eventId === eventId;
    return stepPath.length === 2 && step.events[j]?.eventId === eventId;
}

/** Whether a target still resolves in a snapshot's analysis. */
export function targetStatus(target: Collaboration.ModelTarget, scope: TargetScope): TargetStatus {
    switch (target.kind) {
        case 'Workspace':
            return 'current';
        case 'DtElement':
            if (!scope.model) return 'unknown';
            return modelIdResolves(scope.model, target.element) ? 'current' : 'stale';
        case 'DtesElement':
        case 'DtesOccurrence': {
            const storming = scope.stormings.find((s) => s.id === target.storming);
            if (!storming) return scope.stormingsComplete ? 'stale' : 'unknown';
            if (target.kind === 'DtesElement') return declarations(storming).some((d) => d.id === target.local) ? 'current' : 'stale';
            const stepPath = decodeOccurrencePath(target.occurrence);
            return stepPath && occurrenceResolves(storming, target.timeline, target.eventName, stepPath) ? 'current' : 'stale';
        }
    }
}
