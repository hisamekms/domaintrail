// A session's extractions (ADR 0031, section 3), over ports: the session's talk (its messages, from the session
// database), the extractor (the read-only agent role, reached through the agent API), the store, and the checkpoint
// kept in the session database.
//
// An extraction takes the messages since the previous one (people's and the AI's answers alike) with the talk just
// before them (`contextMinutes`), the items made in this session and those about the stickies the talk points at; the
// extractor replies with operations (`domain/extractor.ts`); the guards sort them (`domain/guards.ts`); what applies is
// sent to the store with the idempotency key of the session and the extraction's number.
//
// The checkpoint makes a restart neither repeat nor lose work. It is written before the store is called: the extraction
// number, the newest message extracted, the held operations, and the operations decided but not yet applied
// (`pending`). Once the store applied them, `pending` is cleared; a store that failed or a process that stopped in
// between has them sent again — the same extraction, the same key, so a store that had applied them applies nothing
// twice — before anything else. An extractor that fails leaves the messages to the next extraction, `maxFailures` times
// in a row, then they are skipped (logged), so that a reply that always fails does not cost an extraction a minute.
//
// What each extraction cost (tokens in and out, the cache read and written, the dollars Claude Code reports) is recorded
// with the checkpoint (`recordCost`) and logged, one line per extraction.
import { Knowledge } from '../generated/index.js';
import type { ResolvedExtractionConfig } from './config.js';
import type { KnowledgeStore } from './ports.js';
import {
    type ExtractionInput,
    type ExtractionResultBody,
    type ExtractionUsage,
    type KnownItem,
    type KnownSticky,
    operationsOf,
    readExtractorReply,
    type TalkMessage,
} from '../domain/extractor.js';
import { guardExtraction, type HeldOperation, nextSettleAt, settleHeld } from '../domain/guards.js';
import type { ExtractionTrigger, TalkState } from '../domain/timing.js';
import { idempotencyKey } from '../domain/extraction.js';

/** A message of the session, as the session database holds it. */
export interface SessionMessage {
    readonly id: string;
    readonly at: Date;
    readonly from: 'person' | 'ai';
    /** `P1`, `P2`, … per person (never a name), or `AI`. */
    readonly author: string;
    readonly text: string;
    readonly stickies: readonly KnownSticky[];
    /** The AI's reply to a message (an answer of the answerer). */
    readonly answer: boolean;
}

/** The session's talk: its messages in order (those the extraction reads; dt's own notices left out). */
export interface SessionTalk {
    messages(): Promise<readonly SessionMessage[]>;
}

/** Where a session's extraction stands: what the session database keeps across restarts. */
export interface ExtractionCheckpoint {
    /** The number of the last extraction (0: none yet). */
    readonly number: number;
    /** The newest message extracted, and when it was sent. */
    readonly lastMessage?: string;
    readonly lastMessageAt?: Date;
    /** When the last extraction started. */
    readonly lastExtractionAt?: Date;
    readonly held: readonly HeldOperation[];
    /** The operations decided and not yet known applied: sent again before anything else. */
    readonly pending?: Knowledge.Extraction;
    /** The extractor's failures in a row on the same messages. */
    readonly failures: number;
}

export const EMPTY_CHECKPOINT: ExtractionCheckpoint = { number: 0, held: [], failures: 0 };

/** What one extraction cost and did: one record per extraction, for measuring the cost per extraction. */
export interface ExtractionCost {
    readonly session: string;
    readonly number: number;
    readonly trigger: ExtractionTrigger;
    readonly at: Date;
    readonly model?: string;
    readonly durationMs: number;
    readonly usage?: ExtractionUsage;
    /** The messages given (new ones and the talk before), the items given. */
    readonly messages: number;
    readonly newMessages: number;
    readonly items: number;
    /** The operations the reply made, those applied now, held, dropped by the guards or the store, rejected as malformed. */
    readonly proposed: number;
    readonly applied: number;
    readonly held: number;
    readonly dropped: number;
    readonly rejected: number;
    readonly error?: string;
}

/** The session database's side of the extraction. */
export interface ExtractionCheckpoints {
    load(session: string): Promise<ExtractionCheckpoint>;
    save(session: string, checkpoint: ExtractionCheckpoint): Promise<void>;
    recordCost(cost: ExtractionCost): Promise<void>;
}

/** The extractor, reached through the agent API: its result, or `unavailable` (none is connected). */
export interface Extractor {
    extract(input: ExtractionInput): Promise<{ readonly kind: 'unavailable' } | { readonly kind: 'done'; readonly result: ExtractionResultBody }>;
}

export interface SessionExtractionDeps {
    readonly project: Knowledge.ProjectName;
    readonly session: string;
    readonly store: KnowledgeStore;
    readonly checkpoints: ExtractionCheckpoints;
    readonly talk: SessionTalk;
    readonly extractor: Extractor;
    readonly config: ResolvedExtractionConfig;
    readonly now: () => Date;
    /** One line per extraction: numbers and kinds only, never a message's text or an item's. */
    readonly log: (line: string) => void;
    /** Extractor failures in a row on the same messages before they are skipped (default 2). */
    readonly maxFailures?: number;
    /** The most items given to the extractor (default 60). */
    readonly maxItems?: number;
    /** The most new messages one extraction takes (default 150; the rest wait for the next). */
    readonly maxNewMessages?: number;
}

/** How an extraction went. */
export type ExtractionRunOutcome =
    | 'nothing-new'
    | 'unavailable'
    | 'failed'
    | 'store-failed'
    | { readonly applied: number; readonly held: number; readonly dropped: number; readonly rejected: number };

export interface SessionExtraction {
    /** Where the talk stands for the timing (the scheduler adds whether one runs and whether the session ended). */
    talkState(): Promise<Omit<TalkState, 'running' | 'ended' | 'endDone'>>;
    /** Extracts the messages since the previous extraction. */
    extract(trigger: ExtractionTrigger): Promise<ExtractionRunOutcome>;
    /** Applies the held operations that settled (all of them when the session ended), and what is pending. */
    settle(ended: boolean): Promise<void>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The messages after the checkpoint's newest one. */
export function messagesSince(all: readonly SessionMessage[], checkpoint: ExtractionCheckpoint): readonly SessionMessage[] {
    if (checkpoint.lastMessage !== undefined) {
        const at = all.findIndex((m) => m.id === checkpoint.lastMessage);
        if (at >= 0) return all.slice(at + 1);
    }
    const since = checkpoint.lastMessageAt?.getTime();
    return since === undefined ? all : all.filter((m) => m.at.getTime() > since);
}

/** What the extractor is given: the talk keyed `m1…`, the items keyed `k1…`, the stickies of the talk. */
export function extractionInput(
    session: string,
    number: number,
    context: readonly SessionMessage[],
    fresh: readonly SessionMessage[],
    items: readonly Knowledge.LiveKnowledgeItem[],
): ExtractionInput {
    const messages: TalkMessage[] = [...context.map((m) => [m, false] as const), ...fresh.map((m) => [m, true] as const)].map(([m, isNew], i) => ({
        key: `m${i + 1}`,
        id: m.id,
        at: m.at.toISOString(),
        from: m.from,
        author: m.author,
        text: m.text,
        stickies: m.stickies.map((s) => s.ref),
        isNew,
    }));
    const stickies = new Map<string, KnownSticky>();
    for (const m of [...context, ...fresh]) for (const s of m.stickies) if (!stickies.get(s.ref)?.label) stickies.set(s.ref, s);
    const keys = new Map(items.map((item, i) => [item.id, `k${i + 1}`]));
    const known: KnownItem[] = items.map((item) => ({
        key: keys.get(item.id) ?? '',
        id: item.id,
        version: item.version,
        text: item.content.text,
        when: item.content.labels.when,
        kind: item.content.labels.kind,
        origin: item.content.labels.origin,
        ...(item.content.labels.perspective !== undefined && { perspective: item.content.labels.perspective }),
        about: [...item.content.about],
        conflictsWith: item.conflictsWith.flatMap((c) => keys.get(c) ?? []),
        thisSession: item.createdIn === session,
        createdAt: item.createdAt.toISOString(),
    }));
    return { session, number, messages, items: known, stickies: [...stickies.values()] };
}

export function createSessionExtraction(deps: SessionExtractionDeps): SessionExtraction {
    const { project, session, store, checkpoints, talk, log } = deps;
    const settleMs = deps.config.settleSeconds * 1000;
    const contextMs = deps.config.contextMinutes * 60_000;
    const maxFailures = deps.maxFailures ?? 2;
    const maxItems = deps.maxItems ?? 60;
    const maxNew = deps.maxNewMessages ?? 150;
    const sessionRef = Knowledge.makeSessionRef(session);
    if (!sessionRef.ok) throw new Error(`Not a session reference: ${session}`);

    const refOf = (number: number): Knowledge.ExtractionRef => {
        const made = Knowledge.makeExtractionNumber(number);
        if (!made.ok) throw new Error(`Not an extraction number: ${number}`);
        return { session: sessionRef.value, number: made.value };
    };

    /** Sends the pending extraction: whether the store took it (the checkpoint then has none pending). */
    const sendPending = async (checkpoint: ExtractionCheckpoint): Promise<{ ok: boolean; dropped: number; checkpoint: ExtractionCheckpoint }> => {
        const pending = checkpoint.pending;
        if (!pending) return { ok: true, dropped: 0, checkpoint };
        try {
            const applied = await store.applyExtraction(project, pending);
            const done = { ...checkpoint, pending: undefined };
            await checkpoints.save(session, done);
            for (const d of applied.dropped) log(`knowledge: extraction ${pending.by.number}: ${d.operation.kind} dropped by the store (${d.reason.type})`);
            if (applied.replayed) log(`knowledge: extraction ${pending.by.number} had been applied (${idempotencyKey(pending.by)})`);
            return { ok: true, dropped: applied.dropped.length, checkpoint: done };
        } catch (e) {
            log(`knowledge: extraction ${pending.by.number} not applied, kept to send again (${message(e)})`);
            return { ok: false, dropped: 0, checkpoint };
        }
    };

    /** The items the extractor is given: this session's first, then those about the stickies, newest first, at most `maxItems`. */
    const itemsFor = async (stickies: readonly string[]): Promise<readonly Knowledge.LiveKnowledgeItem[]> => {
        const refs = stickies.flatMap((s) => {
            const r = Knowledge.makeStickyRef(s);
            return r.ok ? [r.value] : [];
        });
        const [mine, about] = await Promise.all([
            store.search(project, { session: sessionRef.value, limit: maxItems }),
            refs.length ? store.about(project, refs) : Promise.resolve([]),
        ]);
        const byId = new Map<string, Knowledge.LiveKnowledgeItem>();
        for (const item of [...mine.items, ...about]) if (!byId.has(item.id)) byId.set(item.id, item);
        return [...byId.values()].slice(0, maxItems);
    };

    const extraction: SessionExtraction = {
        async talkState() {
            const checkpoint = await checkpoints.load(session);
            const fresh = messagesSince(await talk.messages(), checkpoint);
            const answered = fresh.filter((m) => m.answer).at(-1);
            // something pending is sent at once (as a settle)
            const settleAt = checkpoint.pending ? new Date(0) : nextSettleAt(checkpoint.held, settleMs);
            return {
                ...(checkpoint.lastExtractionAt && { lastExtractionAt: checkpoint.lastExtractionAt }),
                ...(fresh.length > 0 && { lastMessageAt: fresh[fresh.length - 1].at }),
                personWaiting: fresh.some((m) => m.from === 'person'),
                ...(answered && { answeredAt: answered.at }),
                ...(settleAt && { settleAt }),
            };
        },

        async extract(trigger) {
            const started = deps.now();
            let checkpoint = await checkpoints.load(session);
            if (checkpoint.pending) {
                const sent = await sendPending(checkpoint);
                if (!sent.ok) return 'store-failed';
                checkpoint = sent.checkpoint;
            }
            const all = await talk.messages();
            const fresh = messagesSince(all, checkpoint).slice(0, maxNew);
            if (fresh.length === 0) {
                if (trigger === 'end') await extraction.settle(true);
                return 'nothing-new';
            }
            const first = all.indexOf(fresh[0]);
            const from = fresh[0].at.getTime() - contextMs;
            const context = all.slice(0, Math.max(first, 0)).filter((m) => m.at.getTime() >= from);
            const stickies = [...new Set([...context, ...fresh].flatMap((m) => m.stickies.map((s) => s.ref)))];
            let items: readonly Knowledge.LiveKnowledgeItem[];
            try {
                items = await itemsFor(stickies);
            } catch (e) {
                log(`knowledge: the items could not be read for an extraction (${message(e)})`);
                return 'store-failed';
            }
            const number = checkpoint.number + 1;
            const input = extractionInput(session, number, context, fresh, items);
            const last = fresh[fresh.length - 1];
            const answer = await deps.extractor.extract(input);
            if (answer.kind === 'unavailable') return 'unavailable';
            const result = answer.result;
            const base = {
                session,
                number,
                trigger,
                at: started,
                ...(result.model && { model: result.model }),
                durationMs: result.durationMs,
                ...(result.usage && { usage: result.usage }),
                messages: input.messages.length,
                newMessages: fresh.length,
                items: input.items.length,
            };
            const record = async (cost: ExtractionCost): Promise<void> => {
                log(costLine(cost));
                await checkpoints.recordCost(cost).catch((e: unknown) => log(`knowledge: the cost of extraction ${number} not recorded (${message(e)})`));
            };

            if (result.error !== undefined) {
                const failures = checkpoint.failures + 1;
                const skip = failures >= maxFailures;
                await checkpoints.save(session, {
                    ...checkpoint,
                    number,
                    lastExtractionAt: started,
                    failures: skip ? 0 : failures,
                    ...(skip && { lastMessage: last.id, lastMessageAt: last.at }),
                });
                await record({ ...base, proposed: 0, applied: 0, held: checkpoint.held.length, dropped: 0, rejected: 0, error: result.error });
                if (skip) log(`knowledge: extraction ${number} failed ${failures} times on the same messages; ${fresh.length} messages skipped`);
                return 'failed';
            }

            const reply = readExtractorReply(result.reply);
            if (!reply.ok) log(`knowledge: extraction ${number}: the reply is not one (${reply.error.path}: ${reply.error.message}); nothing extracted`);
            const made = reply.ok ? operationsOf(reply.value, input) : { operations: [], rejected: [reply.error] };
            for (const r of made.rejected) log(`knowledge: extraction ${number}: dropped ${r.path} (${r.message})`);
            const decision = guardExtraction({
                proposed: made.operations,
                held: checkpoint.held,
                number,
                talkAt: last.at,
                now: deps.now(),
                settleMs,
                ended: trigger === 'end',
            });
            for (const r of decision.released)
                log(`knowledge: extraction ${number}: a held ${r.held.operation.kind} of extraction ${r.held.heldIn} ${r.outcome}`);
            const pending: Knowledge.Extraction | undefined = decision.apply.length ? { by: refOf(number), operations: decision.apply } : undefined;
            const next: ExtractionCheckpoint = {
                number,
                lastMessage: last.id,
                lastMessageAt: last.at,
                lastExtractionAt: started,
                held: decision.hold,
                ...(pending && { pending }),
                failures: 0,
            };
            await checkpoints.save(session, next);
            const sent = await sendPending(next);
            const superseded = decision.released.filter((r) => r.outcome === 'superseded').length;
            await record({
                ...base,
                proposed: made.operations.length,
                applied: sent.ok ? decision.apply.length - sent.dropped : 0,
                held: decision.hold.length,
                dropped: superseded + decision.duplicates.length + sent.dropped,
                rejected: made.rejected.length,
            });
            if (!sent.ok) return 'store-failed';
            return {
                applied: decision.apply.length - sent.dropped,
                held: decision.hold.length,
                dropped: superseded + decision.duplicates.length + sent.dropped,
                rejected: made.rejected.length,
            };
        },

        async settle(ended) {
            let checkpoint = await checkpoints.load(session);
            if (checkpoint.pending) {
                const sent = await sendPending(checkpoint);
                if (!sent.ok) return;
                checkpoint = sent.checkpoint;
            }
            const decision = settleHeld(checkpoint.held, deps.now(), settleMs, ended);
            if (decision.apply.length === 0) return;
            const number = checkpoint.number + 1;
            for (const r of decision.released)
                log(`knowledge: extraction ${number}: a held ${r.held.operation.kind} of extraction ${r.held.heldIn} ${r.outcome}`);
            const next: ExtractionCheckpoint = { ...checkpoint, number, held: decision.hold, pending: { by: refOf(number), operations: decision.apply } };
            await checkpoints.save(session, next);
            await sendPending(next);
        },
    };
    return extraction;
}

/** The log line of an extraction's cost: numbers only. */
export function costLine(cost: ExtractionCost): string {
    const u = cost.usage;
    const tokens = u
        ? `; tokens in ${u.inputTokens ?? '?'} (cache read ${u.cacheReadTokens ?? 0}, written ${u.cacheCreationTokens ?? 0}), out ${u.outputTokens ?? '?'}${
              u.costUsd !== undefined ? `; $${u.costUsd.toFixed(4)}` : ''
          }`
        : '';
    const what = cost.error
        ? `failed (${cost.error})`
        : `${cost.proposed} proposed: ${cost.applied} applied, ${cost.held} held, ${cost.dropped} dropped, ${cost.rejected} rejected`;
    return `knowledge: extraction ${cost.number} (${cost.trigger}; ${cost.newMessages} new of ${cost.messages} messages, ${cost.items} items): ${what}${tokens}; ${(
        cost.durationMs / 1000
    ).toFixed(1)} s${cost.model ? ` (${cost.model})` : ''}`;
}
