/**
 * Stages, main flows and exceptions (spec §3.7): what they mean, shared by the validator and the projection.
 *
 * A **section** is a stage, or the top-level timelines of a storming without stages. Its `timeline`s are its main flows,
 * the first one its **trunk**; its `exception`s are exceptions. Every timeline but the trunk branches off at its first
 * step from where that step is in the trunk, or in another timeline of the section that branches off itself (its
 * branch point). An exception may end with `then <Event>`, a step of a main flow it returns to. `after` orders stages.
 *
 * Invalid input (reported by the validator, S002–S004 and S017–S022) is left out rather than guessed: an `after` that
 * names no other stage, or that closes a cycle, does not order its stage; a `then` that names no event of a main flow
 * returns nowhere.
 */
import type { Stage, Storming, Timeline, TimelineStep } from './ir.js';
import { firstDeclarations, stormingStages } from './semantic.js';

/** A stage, or (ID `''`) the top-level timelines of a storming without stages. */
export interface Section {
    id: string;
    timelines: Timeline[];
}

/** The events of a step: one for an event step, the members of a group. */
export const stepEvents = (step: TimelineStep): string[] => (step.type === 'event' ? [step.eventId] : step.events.map((e) => e.eventId));

/**
 * Whether the first step of a timeline (`first`) is the step `at` of another timeline: the same event, an event of
 * that group, or a group of the same events (a group is a set: its ID and order do not matter, spec §8.1).
 */
export function sameStep(first: TimelineStep, at: TimelineStep): boolean {
    if (first.type === 'event') return stepEvents(at).includes(first.eventId);
    if (at.type !== 'group') return false;
    const a = new Set(stepEvents(first));
    const b = new Set(stepEvents(at));
    return a.size === b.size && [...a].every((e) => b.has(e));
}

/** The main flows of a section (its `timeline`s, not its `exception`s), in source order. */
export const mainFlows = (section: Section): Timeline[] => section.timelines.filter((t) => !t.exception);

/** The trunk of a section: its first main flow, drawn as one straight row. */
export const trunk = (section: Section): Timeline | undefined => section.timelines.find((t) => !t.exception);

/** Whether a storming has an `exception` anywhere. */
export const hasExceptions = (storming: Storming): boolean =>
    storming.elements.some((el) => (el.kind === 'timeline' ? !!el.exception : el.kind === 'stage' && el.timelines.some((t) => t.exception)));

/**
 * Whether a storming is drawn in sections (its trunks straight, the other timelines branching off them): when it has
 * stages or exceptions. Otherwise its timelines are drawn as they always were, merged by their common prefixes (§8).
 */
export const drawnInSections = (storming: Storming): boolean => storming.elements.some((el) => el.kind === 'stage') || hasExceptions(storming);

/** The top-level timelines of a storming, as a section. */
export const topLevel = (storming: Storming): Section => ({ id: '', timelines: storming.elements.filter((el): el is Timeline => el.kind === 'timeline') });

/** The stages in time order, and the stage each one comes after (the one its valid `after` names). */
export interface StageOrder {
    /** Every stage that owns its ID, each after the one it comes after; otherwise in source order. */
    stages: Stage[];
    /** By stage ID: the stage it comes after, when its `after` is valid. */
    previous: Map<string, string>;
}

/**
 * The order of a storming's stages: a stage comes after the stage its first `after` names, when that is another stage
 * and does not close a cycle (S017); among the stages whose previous ones are placed, the first in source order goes
 * first. A stage without a valid `after` starts anew, after the stages before it.
 */
export function orderStages(storming: Storming): StageOrder {
    const stages = stormingStages(storming);
    const ids = new Set(stages.map((s) => s.id));
    const named = new Map<string, string>();
    for (const s of stages) {
        const after = s.afters[0]?.stageId;
        if (after !== undefined && after !== s.id && ids.has(after)) named.set(s.id, after);
    }
    // an `after` on a cycle orders nothing: every stage of the cycle starts anew
    const previous = new Map<string, string>();
    for (const [id, after] of named) if (!onCycle(id, named)) previous.set(id, after);
    const placed = new Set<string>();
    const order: Stage[] = [];
    while (order.length < stages.length) {
        const next = stages.find((s) => !placed.has(s.id) && (!previous.has(s.id) || placed.has(previous.get(s.id)!)))!;
        placed.add(next.id);
        order.push(next);
    }
    return { stages: order, previous };
}

/** The sections of a storming in time order: its stages, or its top-level timelines when it has no stage. */
export function sections(storming: Storming, order: StageOrder = orderStages(storming)): Section[] {
    return order.stages.length ? order.stages : [topLevel(storming)];
}

/** Whether following `after`s from a stage comes back to it. */
export function onCycle(id: string, after: ReadonlyMap<string, string>): boolean {
    const seen = new Set<string>();
    for (let at = after.get(id); at !== undefined && !seen.has(at); at = after.get(at)) {
        if (at === id) return true;
        seen.add(at);
    }
    return false;
}

/** Where a timeline branches off: a step of the trunk or of another timeline of its section. */
export interface BranchPoint {
    timelineId: string;
    /** The index of the step in that timeline. */
    step: number;
}

/**
 * The branch point of each timeline of a section but its trunk (by timeline ID; one without steps has none): the first
 * step of the trunk that is its first step (`sameStep`); otherwise the first such step of another timeline that has a
 * branch point itself, the one found first by rounds from the trunk, then by timeline ID. A timeline without one is
 * dangling (S019): drawn apart.
 */
export function branchPoints(section: Section): Map<string, BranchPoint | undefined> {
    const byId = new Map<string, Timeline>();
    for (const t of section.timelines) if (!byId.has(t.id)) byId.set(t.id, t);
    const main = trunk(section);
    const others = [...byId.values()].filter((t) => t !== main);
    const out = new Map<string, BranchPoint | undefined>();
    let pending = others.filter((t) => t.steps.length > 0);
    let sources = main ? [main] : [];
    while (pending.length && sources.length) {
        const found: Timeline[] = [];
        for (const t of pending) {
            for (const source of [...sources].sort((a, b) => compare(a.id, b.id))) {
                if (source === t) continue;
                const step = source.steps.findIndex((s) => sameStep(t.steps[0]!, s));
                if (step < 0) continue;
                out.set(t.id, { timelineId: source.id, step });
                found.push(t);
                break;
            }
        }
        pending = pending.filter((t) => !found.includes(t));
        sources = found;
    }
    for (const t of others) if (!out.has(t.id)) out.set(t.id, undefined);
    return out;
}

/** Where a `then` returns to: a step of a main flow of a section. */
export interface RejoinPoint {
    /** The section: a stage's ID, `''` for the top-level timelines. */
    sectionId: string;
    timelineId: string;
    /** The index of the step in that main flow. */
    step: number;
}

/**
 * The step a `then <Event>` of an exception of `section` returns to: the first step with the event of the section's
 * trunk, then of its other main flows, then of the main flows of the other sections in time order (S018 when there is
 * none).
 */
export function rejoinPoint(storming: Storming, section: Section, eventId: string, order: StageOrder = orderStages(storming)): RejoinPoint | undefined {
    if (firstDeclarations(storming).get(eventId)?.kind !== 'event') return undefined;
    const all = sections(storming, order);
    for (const s of [section, ...all.filter((x) => x.id !== section.id)]) {
        for (const t of mainFlows(s)) {
            const step = t.steps.findIndex((st) => stepEvents(st).includes(eventId));
            if (step >= 0) return { sectionId: s.id, timelineId: t.id, step };
        }
    }
    return undefined;
}

/** Code-unit order, independent of the locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
