/**
 * Timelines as occurrences and as a prefix trie (spec §7.2, §8). The trie shares only the leading identical steps of
 * timelines, compared by `stepKey` (a group is the set of its events), and never depends on the order of the timelines:
 * its node IDs are derived from the keys of their path, and every list it gives is sorted.
 */
import type { Timeline } from '@domaintrail/modeling/storming/ir';
import { stepKey, type EventOccurrence, type Step, type StepKey } from './ir.js';

export function timelineOccurrences(timeline: Timeline): EventOccurrence[] {
    return timeline.steps.flatMap((step, i): EventOccurrence[] =>
        step.type === 'event'
            ? [{ timelineId: timeline.id, stepPath: [i], eventId: step.eventId }]
            : step.events.map((e, j) => ({ timelineId: timeline.id, stepPath: [i, j], eventId: e.eventId })),
    );
}

/** A step shared by the timelines whose prefix up to it is the same. */
export interface TrieNode {
    /** `t:<step keys from the root, joined by '>'>`. */
    id: string;
    step: Step;
    /** Keyed by step key (in insertion order: not part of the output). */
    children: Map<StepKey, TrieNode>;
    /** The occurrences of each event of the step (one event for an event step, the members for a group step). */
    occurrences: Map<string, EventOccurrence[]>;
    /** The groups the step stands for (a group step only). */
    groups: { timelineId: string; groupId: string }[];
}

export interface Trie {
    /** Every node but the root, sorted by ID. */
    nodes: TrieNode[];
    /** The nodes of each timeline from its first step, by timeline ID. */
    paths: Map<string, TrieNode[]>;
}

/** The render node ID of an event of a group step. */
export const memberId = (node: TrieNode, eventId: string): string => `${node.id}/${eventId}`;

/** Code-unit order, independent of the locale. */
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareOccurrences = (a: EventOccurrence, b: EventOccurrence): number => {
    const byTimeline = compare(a.timelineId, b.timelineId);
    if (byTimeline !== 0) return byTimeline;
    for (let i = 0; i < Math.min(a.stepPath.length, b.stepPath.length); i++) if (a.stepPath[i] !== b.stepPath[i]) return a.stepPath[i] - b.stepPath[i];
    return a.stepPath.length - b.stepPath.length;
};

/**
 * The prefix trie of `timelines`. Steps naming no event (`isEvent`) are left out, a group keeping its valid events; the
 * occurrences keep their source step paths.
 */
export function buildTrie(timelines: readonly Timeline[], isEvent: (id: string) => boolean): Trie {
    const root = new Map<StepKey, TrieNode>();
    const nodes: TrieNode[] = [];
    const paths = new Map<string, TrieNode[]>();
    for (const timeline of timelines) {
        const path: TrieNode[] = [];
        let children = root;
        for (const [i, s] of timeline.steps.entries()) {
            const occurrences = (
                s.type === 'event' ? [{ eventId: s.eventId, stepPath: [i] }] : s.events.map((e, j) => ({ eventId: e.eventId, stepPath: [i, j] }))
            )
                .filter((o) => isEvent(o.eventId))
                .map((o): EventOccurrence => ({ timelineId: timeline.id, ...o }));
            if (occurrences.length === 0) continue;
            const step: Step =
                s.type === 'event'
                    ? { type: 'event', eventId: s.eventId }
                    : { type: 'group', eventIds: [...new Set(occurrences.map((o) => o.eventId))].sort() };
            const key = stepKey(step);
            let node = children.get(key);
            if (!node) {
                const parent = path.at(-1);
                node = { id: parent ? `${parent.id}>${key}` : `t:${key}`, step, children: new Map(), occurrences: new Map(), groups: [] };
                children.set(key, node);
                nodes.push(node);
            }
            for (const o of occurrences) node.occurrences.set(o.eventId, [...(node.occurrences.get(o.eventId) ?? []), o]);
            if (s.type === 'group') node.groups.push({ timelineId: timeline.id, groupId: s.id });
            path.push(node);
            children = node.children;
        }
        paths.set(timeline.id, path);
    }
    for (const node of nodes) {
        for (const list of node.occurrences.values()) list.sort(compareOccurrences);
        node.groups.sort((a, b) => compare(a.timelineId, b.timelineId) || compare(a.groupId, b.groupId));
    }
    nodes.sort((a, b) => compare(a.id, b.id));
    return { nodes, paths };
}
