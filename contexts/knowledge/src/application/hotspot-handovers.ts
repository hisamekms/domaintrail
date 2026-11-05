// A conflict made a hotspot is handed over to it (ADR 0031, section 4). Pressing ホットスポットにする sends a message
// to the AI and records the press here, kept in the session database with the message's ID, so that every page shows
// the conflict as being made into a hotspot (and a reload keeps it). When the message's run ends, its hotspot is found,
// in this order: the hotspots the run added (the storming's diff before and after it), else the existing ones it
// changed, else the ones its reply names. Exactly one, and both items are handed over to it
// (`KnowledgeStore.handOverToHotspot`, by the person who pressed the button); none or more than one, or a run that
// declined or failed, or a message that never ran (answered as a question, a participant's proposal rejected or
// withdrawn), and the press is forgotten: the conflict gets its two buttons back, with why (`cleared`, kept a while in
// memory, until the conflict is pressed again).
//
// What became of a message is the collaboration's (`outcomeOf`, wired by dt); this only keeps the presses and settles
// them, one settling at a time, whenever the session moved (`settle`).
import { Knowledge } from '../generated/index.js';
import type { KnowledgeStore } from './ports.js';

/** A press of ホットスポットにする waiting for its message's run. */
export interface PendingHandOver {
    /** The message sent to the AI. */
    readonly request: string;
    /** The two items of the conflict. */
    readonly items: readonly [Knowledge.KnowledgeItemId, Knowledge.KnowledgeItemId];
    /** The person who pressed the button: the hand-over is theirs. */
    readonly by: Knowledge.UserName;
    readonly at: Date;
}

/** The session database's side: the presses of a session still waiting, oldest first. */
export interface PendingHandOvers {
    list(session: string): Promise<readonly PendingHandOver[]>;
    /** Keeps a press (a second press with the same message replaces the first). */
    add(session: string, pending: PendingHandOver): Promise<void>;
    remove(session: string, request: string): Promise<void>;
}

/**
 * What became of a message sent to the AI: still on its way (being triaged, a proposal waiting for the facilitator, a
 * run queued, running or asking a question); ran to completion, with the hotspots (`<Storming>.<Local>`) it added, the
 * existing ones it changed, and those its reply names; or ended without a change to hand over to (declined, failed,
 * cancelled, answered as a question, its proposal rejected or withdrawn, the storming unreadable, gone).
 */
export type RequestOutcome =
    | { readonly kind: 'waiting' }
    | { readonly kind: 'ran'; readonly added: readonly string[]; readonly changed: readonly string[]; readonly named: readonly string[] }
    | { readonly kind: 'ended'; readonly why: string };

/** Why a press got its buttons back: no hotspot found, several candidates, or the message ended without a run's change. */
export type ClearedReason = 'none' | 'several' | 'ended';

/** What a settled press came to. */
export type Settled =
    | { readonly kind: 'handedOver'; readonly request: string; readonly hotspot: Knowledge.StickyRef; readonly items: readonly Knowledge.KnowledgeItemId[] }
    | {
          readonly kind: 'cleared';
          readonly request: string;
          readonly items: readonly [Knowledge.KnowledgeItemId, Knowledge.KnowledgeItemId];
          readonly reason: ClearedReason;
          readonly why: string;
      };

/** A conflict whose press was cleared lately: the box shows why its buttons came back. */
export interface ClearedHandOver {
    readonly items: readonly [Knowledge.KnowledgeItemId, Knowledge.KnowledgeItemId];
    readonly reason: ClearedReason;
    readonly at: Date;
}

/** How long a cleared press's reason is shown (in memory: a server started again shows none). */
export const CLEARED_KEPT_MS = 10 * 60_000;

export interface HotspotHandOversDeps {
    readonly session: string;
    readonly project: Knowledge.ProjectName;
    readonly store: KnowledgeStore;
    readonly pending: PendingHandOvers;
    readonly outcomeOf: (request: string) => Promise<RequestOutcome>;
    readonly now: () => Date;
    /** Something changed that the pages show (a press kept, settled): every page reads the knowledge again. */
    readonly changed: () => void;
    readonly log: (line: string) => void;
}

export interface HotspotHandOvers {
    /** A press of ホットスポットにする, its message sent: kept, then settled at once (its message may have run already). */
    press(input: {
        readonly request: string;
        readonly items: readonly [Knowledge.KnowledgeItemId, Knowledge.KnowledgeItemId];
        readonly by: Knowledge.UserName;
    }): Promise<void>;
    /** The presses still waiting, oldest first. */
    list(): Promise<readonly PendingHandOver[]>;
    /** The conflicts whose press was cleared lately (within `CLEARED_KEPT_MS`, not pressed again since), oldest first. */
    cleared(): readonly ClearedHandOver[];
    /** Settles every press whose message's run ended (one settling at a time; a call meanwhile settles again after it). */
    settle(): Promise<readonly Settled[]>;
}

/**
 * The hotspot of a run, or why there is none: the hotspots it added; else the existing ones it changed; else those its
 * reply names. Exactly one candidate at the first step that has any.
 */
export function hotspotOf(
    outcome: Extract<RequestOutcome, { kind: 'ran' }>,
): { readonly hotspot: Knowledge.StickyRef } | { readonly reason: Exclude<ClearedReason, 'ended'>; readonly why: string } {
    const steps = [
        ['added', outcome.added],
        ['changed', outcome.changed],
        ['named', outcome.named],
    ] as const;
    const step = steps.find(([, found]) => found.length > 0);
    if (!step) return { reason: 'none', why: 'the run added, changed or named no hotspot' };
    const [how, found] = step;
    const candidates = [...new Set(found)];
    if (candidates.length > 1) return { reason: 'several', why: `the run ${how} ${candidates.length} hotspots` };
    const made = Knowledge.makeStickyRef(candidates[0] ?? '');
    return made.ok ? { hotspot: made.value } : { reason: 'none', why: `the hotspot ${candidates[0]} cannot be referred to` };
}

export function createHotspotHandOvers(deps: HotspotHandOversDeps): HotspotHandOvers {
    const { session, project, store, pending, log } = deps;
    // the presses cleared lately, in memory
    let cleared: ClearedHandOver[] = [];
    const key = (items: readonly string[]): string => [...items].sort().join('|');
    const forget = (items: readonly string[]): void => {
        cleared = cleared.filter((c) => key(c.items) !== key(items));
    };

    const settleOne = async (p: PendingHandOver): Promise<Settled | undefined> => {
        const outcome = await deps.outcomeOf(p.request);
        if (outcome.kind === 'waiting') return undefined;
        const found = outcome.kind === 'ran' ? hotspotOf(outcome) : { reason: 'ended' as const, why: outcome.why };
        if ('why' in found) {
            await pending.remove(session, p.request);
            forget(p.items);
            cleared.push({ items: p.items, reason: found.reason, at: deps.now() });
            log(`knowledge: the conflict of ${p.items.join(' and ')} was not made a hotspot (${found.why})`);
            return { kind: 'cleared', request: p.request, items: p.items, reason: found.reason, why: found.why };
        }
        const [a, b] = p.items;
        const r = await store.handOverToHotspot(project, a, b, found.hotspot, p.by);
        // an item deleted meanwhile: the other side (if live) was not reached through it; tried from that side
        const handed = r.ok ? r : await store.handOverToHotspot(project, b, a, found.hotspot, p.by);
        await pending.remove(session, p.request);
        const items = handed.ok ? handed.value.map((i) => i.id) : [];
        log(`knowledge: the conflict of ${p.items.join(' and ')} handed over to the hotspot ${found.hotspot}`);
        return { kind: 'handedOver', request: p.request, hotspot: found.hotspot, items };
    };

    let running: Promise<readonly Settled[]> | undefined;
    let again = false;
    const settleAll = async (): Promise<readonly Settled[]> => {
        const settled: Settled[] = [];
        for (const p of await pending.list(session)) {
            try {
                const s = await settleOne(p);
                if (s) settled.push(s);
            } catch (e) {
                // kept: tried again when the session moves next
                log(`knowledge: settling the hotspot of ${p.items.join(' and ')} failed (${e instanceof Error ? e.message : String(e)})`);
            }
        }
        if (settled.length > 0) deps.changed();
        return settled;
    };
    const settle = (): Promise<readonly Settled[]> => {
        if (running) {
            again = true;
            return running;
        }
        const run = async (): Promise<readonly Settled[]> => {
            const all: Settled[] = [];
            do {
                again = false;
                all.push(...(await settleAll()));
            } while (again);
            return all;
        };
        running = run().finally(() => {
            running = undefined;
        });
        return running;
    };

    return {
        async press({ request, items, by }) {
            await pending.add(session, { request, items, by, at: deps.now() });
            forget(items);
            deps.changed();
            await settle();
        },
        list: () => pending.list(session),
        cleared() {
            const since = deps.now().getTime() - CLEARED_KEPT_MS;
            cleared = cleared.filter((c) => c.at.getTime() > since);
            return cleared;
        },
        settle,
    };
}
