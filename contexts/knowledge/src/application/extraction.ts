// A session's extractions (ADR 0031, section 3), over ports: the session's talk (its messages, from the session
// database), the extractor (the read-only agent role, reached through the agent API), the store, and the checkpoint
// kept in the session database.
//
// An extraction takes the messages since the previous one (people's and the AI's answers alike) through three stages
// (`domain/stages.ts`): the mechanical stage, which stops without any model when nothing but surely-nothing messages
// came; the light model (through the extractor role's entry point, as a `gate` job), given the new messages with the
// talk just before them (`gateContextMinutes`) and the stickies' names, which stops only when sure there is no finding;
// and the extractor, given the messages with the talk just before them (`contextMinutes`), the light model's named
// messages marked, the workspace's stickies and the items. The extractor
// replies with operations (`domain/extractor.ts`); the guards sort them (`domain/guards.ts`); what applies is sent to
// the store with the idempotency key of the session and the extraction's number. A stop at the first two stages moves
// the checkpoint past the messages, as an extraction that found nothing.
//
// The checkpoint makes a restart neither repeat nor lose work. It is written before the store is called: the extraction
// number, the newest message extracted, the held operations, and the operations decided but not yet applied
// (`pending`). Once the store applied them, `pending` is cleared; a store that failed or a process that stopped in
// between has them sent again — the same extraction, the same key, so a store that had applied them applies nothing
// twice — before anything else. An extractor that fails leaves the messages to the next extraction, `maxFailures` times
// in a row, then they are skipped (logged), so that a reply that always fails does not cost an extraction a minute.
//
// What each extraction cost and did is recorded with the checkpoint (`recordCost`) and logged, one line per extraction:
// the stage it reached, the messages stage 1 counted, the light model's verdict, and each model's tokens in and out,
// cache read and written, and the dollars Claude Code reports — so that the light model's misses and savings can be
// checked.
//
// The stickies: those the talk points at (`#`), and the workspace's of the stormings the session looks at
// (`domain/stickies.ts`: the storming open on the facilitator's page, the current journey's, else all, capped), read
// from the session (`workspace`) once per extraction and given to both models — the light model their names — so that
// the extractor can say what a finding is about by meaning when nobody pointed at a sticky. The items given are bounded
// (`maxItems`), in this order: those made in this session (an update rewrites them), those about the stickies the talk
// points at, those about the workspace's stickies the new messages write out by label (`mentionedStickies`). A search by
// the messages' words is not used: the stores match every word of a query, and Japanese is not written in words.
//
// The facilitator may switch the extraction off for the session and on again (the scheduler). Switched on again, the
// messages since the checkpoint older than `contextMinutes` are skipped (`resume`): the extraction picks up the talk of
// the usual window, not everything said while it was off.
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
import { droppedOutcome, guardExtraction, type HeldOperation, nextSettleAt, settleHeld } from '../domain/guards.js';
import { type GateInput, type GateReading, type GateVerdict, mechanicalStage, readGateReply } from '../domain/stages.js';
import type { ExtractionTrigger, TalkState } from '../domain/timing.js';
import { chooseStickies, mentionedStickies, type StickyBasis, type StickyFocus, type WorkspaceSticky } from '../domain/stickies.js';
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
    /** A person's message that is surely nothing (the triage's stage 1: empty, emoji only, a fixed acknowledgement). */
    readonly nothing?: boolean;
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

/** The stage an extraction reached: stopped at the mechanical one or the light model's, or the extractor ran. */
export type ExtractionStage = 'mechanical' | 'gate' | 'extractor';

/** What the light model (stage 2) answered and cost. */
export interface GateCost {
    /** Its verdict as taken: a malformed reply or a failure is `unsure`. */
    readonly verdict: GateVerdict;
    /** The new messages it named. */
    readonly named: number;
    /** The messages it was given (new ones and the talk before). */
    readonly messages: number;
    /** The reply was not one. */
    readonly malformed?: boolean;
    readonly error?: string;
    readonly model?: string;
    readonly durationMs: number;
    readonly usage?: ExtractionUsage;
}

/** What one extraction cost and did: one record per extraction, for measuring the cost per extraction and per stage. */
export interface ExtractionCost {
    readonly session: string;
    readonly number: number;
    readonly trigger: ExtractionTrigger;
    readonly at: Date;
    readonly stage: ExtractionStage;
    /** Stage 1's counts of the new messages: people's that are not surely nothing, people's that are, the AI's. */
    readonly people: number;
    readonly nothing: number;
    readonly ai: number;
    /** Stage 2, when it ran. */
    readonly gate?: GateCost;
    /** The extractor's model, duration and usage (stage 3), when it ran. */
    readonly model?: string;
    readonly durationMs?: number;
    readonly usage?: ExtractionUsage;
    /** The messages given to the extractor (new ones and the talk before), the new ones, the items given. */
    readonly messages: number;
    readonly newMessages: number;
    readonly items: number;
    /**
     * The workspace's stickies given (when the session has a workspace): how many, chosen how, how many the cap left out,
     * how many the new messages write out.
     */
    readonly stickies?: { readonly given: number; readonly basis: StickyBasis; readonly left: number; readonly mentioned: number };
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

/** What the extractor role answered a job: its result, or `unavailable` (none is connected). */
export type ExtractorAnswer = { readonly kind: 'unavailable' } | { readonly kind: 'done'; readonly result: ExtractionResultBody };

/** The extractor role, reached through the agent API: the extractor (stage 3), and the light model (stage 2). */
export interface Extractor {
    extract(input: ExtractionInput): Promise<ExtractorAnswer>;
    gate(input: GateInput): Promise<ExtractorAnswer>;
}

export interface SessionExtractionDeps {
    readonly project: Knowledge.ProjectName;
    readonly session: string;
    readonly store: KnowledgeStore;
    readonly checkpoints: ExtractionCheckpoints;
    readonly talk: SessionTalk;
    /** What the session looks at, for the workspace's stickies (`domain/stickies.ts`); absent: only those the talk points at. */
    readonly workspace?: () => Promise<StickyFocus | undefined>;
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
    /** The most of the workspace's stickies given (default `MAX_WORKSPACE_STICKIES`). */
    readonly maxStickies?: number;
}

/** The most stickies written out by label whose items are looked up. */
const MAX_MENTIONED = 20;

/** How an extraction went. */
export type ExtractionRunOutcome =
    | 'nothing-new'
    /** Stopped before the extractor: nothing to extract (stage 1), or the light model was sure there is nothing (stage 2). */
    | { readonly stoppedAt: 'mechanical' | 'gate' }
    | 'unavailable'
    | 'failed'
    | 'store-failed'
    | { readonly applied: number; readonly held: number; readonly dropped: number; readonly rejected: number };

export interface SessionExtraction {
    /** Where the talk stands for the timing (the scheduler adds whether one runs and whether the session ended). */
    talkState(): Promise<Omit<TalkState, 'running' | 'ended' | 'endDone'>>;
    /** Extracts the messages since the previous extraction. */
    extract(trigger: ExtractionTrigger): Promise<ExtractionRunOutcome>;
    /** Applies the held operations that settled (the others dropped when the session ended), and what is pending. */
    settle(ended: boolean): Promise<void>;
    /**
     * The extraction was switched on again: the messages since the checkpoint older than `contextMinutes` are skipped
     * (the checkpoint moved past them). How many were.
     */
    resume(): Promise<number>;
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

/** The talk keyed `m1…`: the context, then the new messages (`likely`: those the light model named). */
function talkMessages(context: readonly SessionMessage[], fresh: readonly SessionMessage[], likely: ReadonlySet<string> = new Set()): TalkMessage[] {
    return [...context.map((m) => [m, false] as const), ...fresh.map((m) => [m, true] as const)].map(([m, isNew], i) => ({
        key: `m${i + 1}`,
        id: m.id,
        at: m.at.toISOString(),
        from: m.from,
        author: m.author,
        text: m.text,
        stickies: m.stickies.map((s) => s.ref),
        isNew,
        ...(isNew && likely.has(m.id) && { likely: true }),
    }));
}

/** The stickies the messages point at, each once, with a label when one of them gave it. */
function stickiesOf(messages: readonly SessionMessage[]): KnownSticky[] {
    const stickies = new Map<string, KnownSticky>();
    for (const m of messages) for (const s of m.stickies) if (!stickies.get(s.ref)?.label) stickies.set(s.ref, s);
    return [...stickies.values()];
}

/** A sticky's name: its label, else its ref. */
const nameOf = (s: { readonly ref: string; readonly label?: string }): string => s.label ?? s.ref;

/**
 * What the light model is given: the talk keyed `m1…`, the names of its stickies (their labels, else their refs), and
 * the names of the workspace's stickies the extractor is given too.
 */
export function gateInput(
    session: string,
    number: number,
    context: readonly SessionMessage[],
    fresh: readonly SessionMessage[],
    workspace: readonly WorkspaceSticky[] = [],
): GateInput {
    const names = [...new Set(stickiesOf([...context, ...fresh]).map(nameOf))];
    const known = [...new Set(workspace.map(nameOf))];
    return { session, number, messages: talkMessages(context, fresh), stickies: names, ...(known.length > 0 && { workspaceStickies: known }) };
}

/**
 * What the extractor is given: the talk keyed `m1…` (`likely`: the new messages the light model named), the items keyed
 * `k1…`, the stickies of the talk, the workspace's stickies and those of them the new messages write out.
 */
export function extractionInput(
    session: string,
    number: number,
    context: readonly SessionMessage[],
    fresh: readonly SessionMessage[],
    items: readonly Knowledge.LiveKnowledgeItem[],
    likely: ReadonlySet<string> = new Set(),
    workspace: readonly WorkspaceSticky[] = [],
    mentioned: readonly string[] = [],
): ExtractionInput {
    const messages = talkMessages(context, fresh, likely);
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
    return {
        session,
        number,
        messages,
        items: known,
        stickies: stickiesOf([...context, ...fresh]),
        ...(workspace.length > 0 && { workspaceStickies: workspace }),
        ...(mentioned.length > 0 && { mentioned }),
    };
}

export function createSessionExtraction(deps: SessionExtractionDeps): SessionExtraction {
    const { project, session, store, checkpoints, talk, log } = deps;
    const settleMs = deps.config.settleSeconds * 1000;
    const contextMs = deps.config.contextMinutes * 60_000;
    const gateContextMs = deps.config.gateContextMinutes * 60_000;
    const maxFailures = deps.maxFailures ?? 2;
    const maxItems = deps.maxItems ?? 60;
    const maxNew = deps.maxNewMessages ?? 150;
    const maxStickies = deps.maxStickies;
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

    /**
     * The items the extractor is given, at most `maxItems`: this session's first, then those about the stickies the talk
     * points at, then those about the stickies it writes out (each newest first).
     */
    const itemsFor = async (targeted: readonly string[], mentioned: readonly string[]): Promise<readonly Knowledge.LiveKnowledgeItem[]> => {
        const refsOf = (stickies: readonly string[]): Knowledge.StickyRef[] =>
            stickies.flatMap((s) => {
                const r = Knowledge.makeStickyRef(s);
                return r.ok ? [r.value] : [];
            });
        const aboutOf = (refs: readonly Knowledge.StickyRef[]): Promise<readonly Knowledge.LiveKnowledgeItem[]> =>
            refs.length ? store.about(project, refs) : Promise.resolve([]);
        const [mine, pointed, written] = await Promise.all([
            store.search(project, { session: sessionRef.value, limit: maxItems }),
            aboutOf(refsOf(targeted)),
            aboutOf(refsOf(mentioned)),
        ]);
        const byId = new Map<string, Knowledge.LiveKnowledgeItem>();
        for (const item of [...mine.items, ...pointed, ...written]) if (!byId.has(item.id)) byId.set(item.id, item);
        return [...byId.values()].slice(0, maxItems);
    };

    /** The workspace's stickies for this extraction (none when the session has no workspace or it cannot be read). */
    const workspaceFor = async (targeted: readonly string[], number: number): Promise<ReturnType<typeof chooseStickies> | undefined> => {
        if (!deps.workspace) return undefined;
        try {
            const focus = await deps.workspace();
            return focus && chooseStickies(focus, targeted, maxStickies);
        } catch (e) {
            log(`knowledge: extraction ${number}: the workspace's stickies could not be read (${message(e)}); only those the talk points at`);
            return undefined;
        }
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
            const before = all.slice(0, Math.max(first, 0));
            const within = (ms: number): readonly SessionMessage[] => before.filter((m) => m.at.getTime() >= fresh[0].at.getTime() - ms);
            const number = checkpoint.number + 1;
            const last = fresh[fresh.length - 1];
            const record = async (cost: ExtractionCost): Promise<void> => {
                log(costLine(cost));
                await checkpoints.recordCost(cost).catch((e: unknown) => log(`knowledge: the cost of extraction ${number} not recorded (${message(e)})`));
            };
            const nothingDone = { proposed: 0, applied: 0, held: checkpoint.held.length, dropped: 0, rejected: 0 };
            /** Stopped before the extractor: the checkpoint moves past the messages, as an extraction that found nothing. */
            const stop = async (stage: 'mechanical' | 'gate', cost: ExtractionCost): Promise<ExtractionRunOutcome> => {
                await checkpoints.save(session, {
                    ...checkpoint,
                    number,
                    lastMessage: last.id,
                    lastMessageAt: last.at,
                    // a model ran (the light one): the minute between extractions counts from it
                    ...(stage === 'gate' && { lastExtractionAt: started }),
                    failures: 0,
                });
                await record(cost);
                // the end: what is held settles or is dropped all the same
                if (trigger === 'end') await extraction.settle(true);
                return { stoppedAt: stage };
            };

            // stage 1: mechanical
            const mechanical = mechanicalStage(fresh);
            const counts = { people: mechanical.people, nothing: mechanical.nothing, ai: mechanical.ai };
            const base = { session, number, trigger, at: started, ...counts, newMessages: fresh.length };
            if (!mechanical.go) return stop('mechanical', { ...base, stage: 'mechanical', messages: 0, items: 0, ...nothingDone });

            // the stickies: those the talk points at, the workspace's (the same for both models)
            const context = within(contextMs);
            const targeted = [...new Set([...context, ...fresh].flatMap((m) => m.stickies.map((s) => s.ref)))];
            const chosen = await workspaceFor(targeted, number);
            const workspace = chosen?.stickies ?? [];

            // stage 2: the light model
            const asked = gateInput(session, number, within(gateContextMs), fresh, workspace);
            const gated = await deps.extractor.gate(asked);
            if (gated.kind === 'unavailable') return 'unavailable';
            const reading: GateReading =
                gated.result.error === undefined ? readGateReply(gated.result.reply, asked) : { verdict: 'unsure', named: [], malformed: false };
            const gate: GateCost = {
                verdict: reading.verdict,
                named: reading.named.length,
                messages: asked.messages.length,
                ...(reading.malformed && { malformed: true }),
                ...(gated.result.error !== undefined && { error: gated.result.error }),
                ...(gated.result.model && { model: gated.result.model }),
                durationMs: gated.result.durationMs,
                ...(gated.result.usage && { usage: gated.result.usage }),
            };
            if (gated.result.error !== undefined) log(`knowledge: extraction ${number}: the light model failed (${gated.result.error}); extracting anyway`);
            else if (reading.malformed) log(`knowledge: extraction ${number}: the light model's reply is not one; extracting anyway`);
            if (reading.verdict === 'no') return stop('gate', { ...base, stage: 'gate', gate, messages: 0, items: 0, ...nothingDone });

            // stage 3: the extractor, the messages the light model named first
            const pointedAt = new Set(targeted);
            const mentioned = mentionedStickies(
                workspace,
                fresh.map((m) => m.text),
            )
                .filter((r) => !pointedAt.has(r))
                .slice(0, MAX_MENTIONED);
            let items: readonly Knowledge.LiveKnowledgeItem[];
            try {
                items = await itemsFor(targeted, mentioned);
            } catch (e) {
                log(`knowledge: the items could not be read for an extraction (${message(e)})`);
                return 'store-failed';
            }
            const input = extractionInput(session, number, context, fresh, items, new Set(reading.named), workspace, mentioned);
            const answer = await deps.extractor.extract(input);
            if (answer.kind === 'unavailable') return 'unavailable';
            const result = answer.result;
            const extracted = {
                ...base,
                stage: 'extractor' as const,
                gate,
                ...(result.model && { model: result.model }),
                durationMs: result.durationMs,
                ...(result.usage && { usage: result.usage }),
                messages: input.messages.length,
                items: input.items.length,
                ...(chosen && { stickies: { given: chosen.stickies.length, basis: chosen.basis, left: chosen.left, mentioned: mentioned.length } }),
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
                await record({ ...extracted, ...nothingDone, error: result.error });
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
            for (const o of decision.endDropped) log(`knowledge: extraction ${number}: its ${o.kind} dropped, the session ended`);
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
            const dropped =
                decision.released.filter((r) => droppedOutcome(r.outcome)).length + decision.duplicates.length + decision.endDropped.length + sent.dropped;
            const done = { proposed: made.operations.length, applied: sent.ok ? decision.apply.length - sent.dropped : 0, held: decision.hold.length, dropped };
            await record({ ...extracted, ...done, rejected: made.rejected.length });
            if (!sent.ok) return 'store-failed';
            return { applied: decision.apply.length - sent.dropped, held: decision.hold.length, dropped, rejected: made.rejected.length };
        },

        async settle(ended) {
            let checkpoint = await checkpoints.load(session);
            if (checkpoint.pending) {
                const sent = await sendPending(checkpoint);
                if (!sent.ok) return;
                checkpoint = sent.checkpoint;
            }
            const decision = settleHeld(checkpoint.held, deps.now(), settleMs, ended);
            if (decision.released.length === 0) return;
            const number = decision.apply.length ? checkpoint.number + 1 : checkpoint.number;
            for (const r of decision.released)
                log(
                    `knowledge: a held ${r.held.operation.kind} of extraction ${r.held.heldIn} ${r.outcome === 'ended' ? 'dropped: the session ended' : r.outcome}`,
                );
            const next: ExtractionCheckpoint = {
                ...checkpoint,
                number,
                held: decision.hold,
                ...(decision.apply.length > 0 && { pending: { by: refOf(number), operations: decision.apply } }),
            };
            await checkpoints.save(session, next);
            await sendPending(next);
        },

        async resume() {
            const checkpoint = await checkpoints.load(session);
            const cutoff = deps.now().getTime() - contextMs;
            const skipped = messagesSince(await talk.messages(), checkpoint).filter((m) => m.at.getTime() < cutoff);
            const newest = skipped.at(-1);
            if (!newest) return 0;
            await checkpoints.save(session, { ...checkpoint, lastMessage: newest.id, lastMessageAt: newest.at, failures: 0 });
            log(`knowledge: the extraction is on again; ${skipped.length} messages older than ${deps.config.contextMinutes} minutes are not extracted`);
            return skipped.length;
        },
    };
    return extraction;
}

/** A model's turn in a log line: its tokens, cache and dollars, its duration and model. */
function turnText(usage: ExtractionUsage | undefined, durationMs: number | undefined, model: string | undefined): string {
    const tokens = usage
        ? `; tokens in ${usage.inputTokens ?? '?'} (cache read ${usage.cacheReadTokens ?? 0}, written ${usage.cacheCreationTokens ?? 0}), out ${usage.outputTokens ?? '?'}${
              usage.costUsd !== undefined ? `; $${usage.costUsd.toFixed(4)}` : ''
          }`
        : '';
    return `${tokens}; ${((durationMs ?? 0) / 1000).toFixed(1)} s${model ? ` (${model})` : ''}`;
}

/** The log line of an extraction's cost: numbers only. */
export function costLine(cost: ExtractionCost): string {
    const head = `knowledge: extraction ${cost.number} (${cost.trigger}; `;
    const g = cost.gate;
    const gate = g
        ? `light model: ${g.verdict}${g.malformed ? ' (reply not one)' : ''}${g.error ? ` (failed: ${g.error})` : ''}, ${g.named} named${turnText(g.usage, g.durationMs, g.model)}`
        : '';
    switch (cost.stage) {
        case 'mechanical':
            return `${head}${cost.newMessages} new messages): stopped at the mechanical stage (${cost.people} people's, ${cost.nothing} surely nothing, ${cost.ai} the AI's)`;
        case 'gate':
            return `${head}${cost.newMessages} new messages): stopped by the ${gate}`;
        case 'extractor': {
            const what = cost.error
                ? `failed (${cost.error})`
                : `${cost.proposed} proposed: ${cost.applied} applied, ${cost.held} held, ${cost.dropped} dropped, ${cost.rejected} rejected`;
            const st = cost.stickies;
            const stickies = st
                ? `, ${st.given} stickies (${st.basis === 'focus' ? 'the stormings looked at' : 'all stormings'}${st.left ? `, ${st.left} left out` : ''}; ${st.mentioned} written out)`
                : '';
            return `${head}${cost.newMessages} new of ${cost.messages} messages, ${cost.items} items${stickies}): ${what}${turnText(cost.usage, cost.durationMs, cost.model)}${
                gate ? `; ${gate}` : ''
            }`;
        }
    }
}
