// A conflict made a hotspot is handed over to it (ADR 0031, section 4). Pressing ホットスポットにする sends a message
// to the AI and records the press here, kept in the session database with the message's ID, so that every page shows
// the conflict as being made into a hotspot (and a reload keeps it). When the message's run ends, the hotspots the run
// added are read from the storming's diff before and after it: exactly one, and both items are handed over to it
// (`KnowledgeStore.handOverToHotspot`, by the person who pressed the button); none or more than one, or a run that
// declined or failed, or a message that never ran (answered as a question, a participant's proposal rejected or
// withdrawn), and the press is forgotten: the conflict gets its two buttons back.
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
 * run queued, running or asking a question); ran to completion, with the hotspots it added (`complete: false` when the
 * storming's diff could not be read); or ended without a change to hand over to (declined, failed, cancelled, answered
 * as a question, its proposal rejected or withdrawn, gone).
 */
export type RequestOutcome =
    | { readonly kind: 'waiting' }
    | { readonly kind: 'ran'; readonly hotspots: readonly string[] }
    | { readonly kind: 'ended'; readonly why: string };

/** What a settled press came to. */
export type Settled =
    | { readonly kind: 'handedOver'; readonly request: string; readonly hotspot: Knowledge.StickyRef; readonly items: readonly Knowledge.KnowledgeItemId[] }
    | { readonly kind: 'cleared'; readonly request: string; readonly why: string };

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
    /** Settles every press whose message's run ended (one settling at a time; a call meanwhile settles again after it). */
    settle(): Promise<readonly Settled[]>;
}

/** The one hotspot a run added, or why it is not handed over to. */
export function hotspotOf(outcome: Extract<RequestOutcome, { kind: 'ran' }>): { readonly hotspot: Knowledge.StickyRef } | { readonly why: string } {
    if (outcome.hotspots.length === 0) return { why: 'the run added no hotspot' };
    if (outcome.hotspots.length > 1) return { why: `the run added ${outcome.hotspots.length} hotspots` };
    const made = Knowledge.makeStickyRef(outcome.hotspots[0] ?? '');
    return made.ok ? { hotspot: made.value } : { why: `the hotspot ${outcome.hotspots[0]} cannot be referred to` };
}

export function createHotspotHandOvers(deps: HotspotHandOversDeps): HotspotHandOvers {
    const { session, project, store, pending, log } = deps;

    const settleOne = async (p: PendingHandOver): Promise<Settled | undefined> => {
        const outcome = await deps.outcomeOf(p.request);
        if (outcome.kind === 'waiting') return undefined;
        const found = outcome.kind === 'ran' ? hotspotOf(outcome) : { why: outcome.why };
        if ('why' in found) {
            await pending.remove(session, p.request);
            log(`knowledge: the conflict of ${p.items.join(' and ')} was not made a hotspot (${found.why})`);
            return { kind: 'cleared', request: p.request, why: found.why };
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
            deps.changed();
            await settle();
        },
        list: () => pending.list(session),
        settle,
    };
}
