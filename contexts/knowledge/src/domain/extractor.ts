// The extractor's side of an extraction (ADR 0031, section 3): what the read-only agent is given — the talk and the
// items, each keyed for the prompt (`m1`, `k1`: the model never copies an ID) —, the JSON it replies with, that reply
// read without trusting it, and the reply made into an extraction's operations.
//
// The reply is AI output. Reading it, a reply that is not an object with `operations` is refused whole (nothing is
// extracted); within it, each operation is read on its own, and a malformed one is dropped with why, the others kept.
// Making operations of it, a reference to a message or an item the extractor was not given drops the operation; a sticky
// it was not given (neither one of the workspace's it was given, nor one the talk points at, nor one an item is about) is
// left out of `about`; a quote that is not in its message is replaced by the message's own start
// (the quote is what lets a reader check the AI's wording, so it must be the person's). The IDs of new items are made
// from the session, the extraction's number and the operation's place, so that the same extraction sent again names the
// same items.
import { err, Knowledge, ok, type Result } from '../generated/index.js';
import type { GateInput } from './stages.js';
import type { WorkspaceSticky } from './stickies.js';

/** The most of each part of a reply, and of an input. */
export const EXTRACTION_LIMITS = {
    operations: 40,
    /** A title's most characters (`ItemTitle`). */
    title: 40,
    text: 4000,
    reason: 500,
    quote: 300,
    about: 20,
    sources: 10,
    /** A quote made from a message's start when the extractor's is not in the message. */
    fallbackQuote: 200,
} as const;

export const KNOWLEDGE_WHENS: readonly Knowledge.When[] = ['as_is', 'to_be', 'none'];
export const KNOWLEDGE_KINDS: readonly Knowledge.KnowledgeKind[] = ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'];
export const KNOWLEDGE_ORIGINS: readonly Knowledge.Origin[] = ['said', 'agreed', 'investigated', 'inferred'];

// ---- what the extractor is given ------------------------------------------------------------------------------------

/** A message of the talk as the extractor sees it. */
export interface TalkMessage {
    /** The prompt's key (`m1`, `m2`, …), which the reply names. */
    readonly key: string;
    /** The message's ID in the session. */
    readonly id: string;
    /** When it was sent (ISO 8601). */
    readonly at: string;
    readonly from: 'person' | 'ai';
    /** Who wrote it: `P1`, `P2`, … per person in the session (never a name), or `AI`. */
    readonly author: string;
    /** Its text (elements as `#label`). */
    readonly text: string;
    /** The stickies it points at (`<Storming>.<LocalId>`). */
    readonly stickies: readonly string[];
    /** Since the previous extraction (else the talk before them, context only). */
    readonly isNew: boolean;
    /** A new message the light model named as likely holding a finding (stage 2): read first. */
    readonly likely?: boolean;
}

/** An existing item as the extractor sees it. */
export interface KnownItem {
    /** The prompt's key (`k1`, `k2`, …), which the reply names. */
    readonly key: string;
    readonly id: string;
    readonly version: number;
    readonly title: string;
    readonly text: string;
    readonly when: Knowledge.When;
    readonly kind: Knowledge.KnowledgeKind;
    readonly origin: Knowledge.Origin;
    readonly perspective?: string;
    readonly about: readonly string[];
    /** The keys of the items it conflicts with that are given too. */
    readonly conflictsWith: readonly string[];
    /** Made in this session (an update rewrites it in place). */
    readonly thisSession: boolean;
    /** When it was made (ISO 8601). */
    readonly createdAt: string;
}

/**
 * A retired item as the extractor sees it: its title and reason only, so as not to make it again (its text is never
 * given, so nothing rests on it). When the talk brings its topic up anew, the extractor proposes to unretire it.
 */
export interface RetiredItem {
    /** The prompt's key (`r1`, `r2`, …), which the reply names. */
    readonly key: string;
    readonly id: string;
    readonly title: string;
    readonly reason?: Knowledge.RetirementReason;
}

/** A sticky the talk points at (a message's `#` chip): a strong hint of what a finding is about. */
export interface KnownSticky {
    readonly ref: string;
    /** Its label when the message pointed at it. */
    readonly label?: string;
}

/** What one extraction is given. */
export interface ExtractionInput {
    readonly session: string;
    readonly number: number;
    /** The talk in order: the new messages, after the talk just before them (`isNew` false). */
    readonly messages: readonly TalkMessage[];
    /** The items made in this session and those about the stickies the talk is likely about. */
    readonly items: readonly KnownItem[];
    /** The stickies the talk points at. */
    readonly stickies: readonly KnownSticky[];
    /**
     * The workspace's stickies of the stormings the session looks at (`chooseStickies`), the same from one extraction to
     * the next while the view and the stormings stay: `about` is chosen among them by meaning. Absent from a server
     * before them.
     */
    readonly workspaceStickies?: readonly WorkspaceSticky[];
    /** The workspace's stickies whose label the talk writes out without pointing at them (`mentionedStickies`). */
    readonly mentioned?: readonly string[];
    /** The retired items about the same stickies and those of this session: titles and reasons only. */
    readonly retired?: readonly RetiredItem[];
    /**
     * Items the review at the end of an AI run found at odds with the stickies as the run left them (ADR 0034), by
     * their key among `items`: a hint for a `conflict` when the talk states the new decision; never a reason to change
     * an item by itself.
     */
    readonly reviewFlags?: readonly ReviewFlag[];
}

/** An item the review of an AI run flagged (ADR 0034): its key, the sticky, and why (the agent's words). */
export interface ReviewFlag {
    readonly item: string;
    readonly sticky: string;
    readonly why: string;
}

// ---- the agent API's extraction entry point --------------------------------------------------------------------------

/** The SSE event names of the extraction stream (`GET /agent/extractions/events`). */
export const EXTRACTION_EVENT_TYPES = {
    job: 'extraction.job',
    withdrawn: 'extraction.job_withdrawn',
    closed: 'session.closed',
} as const;

/**
 * A light question beside the extractions (ADR 0033): the light model names a hotspot a person writes on a sticky —
 * a short English ID from its question and the sticky, which the server checks and writes. The extractor role asks it
 * as it asks the gate (no tools, the light model).
 */
export interface HotspotNameInput {
    /** The hotspot's question, as the person wrote it. */
    readonly question: string;
    /** The sticky it is on: its ID, label and kind. */
    readonly on: { readonly id: string; readonly label?: string; readonly kind: string };
    /** The IDs the storming declares already (every kind; at most `HOTSPOT_TAKEN_MAX`): the name must be none of them. */
    readonly taken?: readonly string[];
    /** The name an earlier answer gave that is taken: asked again, naming it. */
    readonly clash?: string;
}

/** The most IDs of the storming a hotspot's name job lists. */
export const HOTSPOT_TAKEN_MAX = 300;

/** The most characters of a hotspot's name the light model may give (the server shortens and checks it again). */
export const HOTSPOT_NAME_MAX = 40;

/** The JSON schema of the light model's reply to a hotspot's name (`--json-schema`): `{ name }`, English PascalCase. */
export function hotspotNameJsonSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: { name: { type: 'string', pattern: `^[A-Z][A-Za-z0-9]{1,${HOTSPOT_NAME_MAX - 1}}$` } },
        required: ['name'],
        additionalProperties: false,
    };
}

/**
 * An extraction job, as the stream hands it to the extractor: an extraction (stage 3; `stage` absent from a server
 * before the stages), the light model's question whether to extract (stage 2, `gate`), or its name of a hotspot
 * (`hotspotName`, ADR 0033).
 */
export type ExtractionJobBody = (
    | (ExtractionInput & { readonly stage?: 'extract' })
    | (GateInput & { readonly stage: 'gate' })
    | (HotspotNameInput & { readonly stage: 'hotspotName' })
) & {
    readonly job: string;
    /** The most milliseconds the job may take. */
    readonly timeoutMs: number;
};

/** What a turn of the model cost, as Claude Code reports it. */
export interface ExtractionUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly costUsd?: number;
}

/** `POST /agent/extractions/:job`: the reply (unvalidated) or why there is none, with what it cost. */
export interface ExtractionResultBody {
    readonly reply?: unknown;
    readonly error?: string;
    readonly model?: string;
    readonly durationMs: number;
    readonly usage?: ExtractionUsage;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The usage as reported (each number kept only when it is one). */
export function readUsage(raw: unknown): ExtractionUsage | undefined {
    if (!isObject(raw)) return undefined;
    const usage: ExtractionUsage = {
        ...(count(raw.inputTokens) !== undefined && { inputTokens: count(raw.inputTokens) }),
        ...(count(raw.outputTokens) !== undefined && { outputTokens: count(raw.outputTokens) }),
        ...(count(raw.cacheReadTokens) !== undefined && { cacheReadTokens: count(raw.cacheReadTokens) }),
        ...(count(raw.cacheCreationTokens) !== undefined && { cacheCreationTokens: count(raw.cacheCreationTokens) }),
        ...(count(raw.costUsd) !== undefined && { costUsd: count(raw.costUsd) }),
    };
    return Object.keys(usage).length ? usage : undefined;
}

// ---- the reply -------------------------------------------------------------------------------------------------------

/** A finding as the extractor states it. */
export interface ReplyFinding {
    /** One short line, plain text. */
    readonly title: string;
    readonly text: string;
    readonly when: Knowledge.When;
    readonly kind: Knowledge.KnowledgeKind;
    readonly origin: Knowledge.Origin;
    readonly perspective?: string;
    /** Sticky refs. */
    readonly about: readonly string[];
}

/** A source as the extractor names it: a message's key and a short quote of it. */
export interface ReplySource {
    readonly message: string;
    readonly quote: string;
}

/** One operation of the reply, its references still the prompt's keys. */
export type ReplyOperation =
    | { readonly op: 'add'; readonly finding: ReplyFinding; readonly sources: readonly ReplySource[]; readonly reason: string }
    | { readonly op: 'addSource'; readonly item: string; readonly sources: readonly ReplySource[]; readonly agreed: boolean; readonly reason: string }
    | { readonly op: 'update'; readonly item: string; readonly finding: ReplyFinding; readonly sources: readonly ReplySource[]; readonly reason: string }
    | {
          readonly op: 'conflict';
          readonly item: string;
          readonly finding: ReplyFinding;
          readonly sources: readonly ReplySource[];
          readonly reason: string;
      }
    /** Propose to retire an item (a person approves): its reason, the replacing item for `replaced`, and the evidence. */
    | {
          readonly op: 'retire';
          readonly item: string;
          readonly retirement: Knowledge.RetirementReason;
          readonly replacedBy?: string;
          /** The decisions (items of kind `decision`) it rests on. */
          readonly decisions: readonly string[];
          readonly sources: readonly ReplySource[];
          readonly reason: string;
      }
    /** Propose to undo a retirement: the talk brought the retired item's topic up anew (the messages). */
    | { readonly op: 'unretire'; readonly item: string; readonly sources: readonly ReplySource[]; readonly reason: string };

/** Where a reply or one of its operations is wrong. */
export interface ReplyProblem {
    readonly path: string;
    readonly message: string;
}

/** A reply read: its well-formed operations, and the others dropped with why. */
export interface ExtractorReply {
    readonly operations: readonly ReplyOperation[];
    readonly rejected: readonly ReplyProblem[];
}

const OPS = ['add', 'addSource', 'update', 'conflict', 'retire', 'unretire'] as const;
const RETIREMENT_REASONS: readonly Knowledge.RetirementReason[] = ['replaced', 'obsolete', 'wrong'];

/** The JSON schema of the reply (`--json-schema`): `{ operations: [...] }`, each operation one flat object. */
export function extractorJsonSchema(): Record<string, unknown> {
    const string = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
    return {
        type: 'object',
        properties: {
            operations: {
                type: 'array',
                maxItems: EXTRACTION_LIMITS.operations,
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: [...OPS] },
                        item: { type: 'string', pattern: '^[kr][0-9]+$' },
                        retirement: { type: 'string', enum: [...RETIREMENT_REASONS] },
                        replacedBy: { type: 'string', pattern: '^k[0-9]+$' },
                        decisions: { type: 'array', maxItems: EXTRACTION_LIMITS.sources, items: { type: 'string', pattern: '^k[0-9]+$' } },
                        title: string(EXTRACTION_LIMITS.title),
                        text: string(EXTRACTION_LIMITS.text),
                        when: { type: 'string', enum: [...KNOWLEDGE_WHENS] },
                        kind: { type: 'string', enum: [...KNOWLEDGE_KINDS] },
                        origin: { type: 'string', enum: [...KNOWLEDGE_ORIGINS] },
                        perspective: string(100),
                        about: { type: 'array', maxItems: EXTRACTION_LIMITS.about, items: { type: 'string' } },
                        sources: {
                            type: 'array',
                            minItems: 1,
                            maxItems: EXTRACTION_LIMITS.sources,
                            items: {
                                type: 'object',
                                properties: { message: { type: 'string', pattern: '^m[0-9]+$' }, quote: string(EXTRACTION_LIMITS.quote) },
                                required: ['message', 'quote'],
                                additionalProperties: false,
                            },
                        },
                        agreed: { type: 'boolean' },
                        reason: string(EXTRACTION_LIMITS.reason),
                    },
                    required: ['op', 'reason'],
                    additionalProperties: false,
                },
            },
        },
        required: ['operations'],
        additionalProperties: false,
    };
}

type Read<T> = Result<T, ReplyProblem>;
const problem = (path: string, message: string): Read<never> => err({ path, message });

const textOf = (v: unknown, path: string, max: number): Read<string> => {
    if (typeof v !== 'string' || !v.trim()) return problem(path, 'Expected a text.');
    return ok(v.trim().slice(0, max));
};
const oneOf = <T extends string>(v: unknown, values: readonly T[], path: string): Read<T> => {
    const found = values.find((x) => x === v);
    return found === undefined ? problem(path, `Expected one of ${values.join(', ')}.`) : ok(found);
};

/**
 * A title as one line: its breaks and runs of spaces made one space; past the most characters, cut with "…" (the schema
 * asks for a short one, so this is a model's slip, and a title cut short still reads).
 */
export function titleOf(v: unknown, path: string): Read<string> {
    if (typeof v !== 'string' || !v.trim()) return problem(path, 'Expected a title.');
    const line = spaced(v);
    const max = EXTRACTION_LIMITS.title;
    return ok(line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`);
}

function readFinding(raw: Record<string, unknown>, path: string): Read<ReplyFinding> {
    const title = titleOf(raw.title, `${path}.title`);
    if (!title.ok) return title;
    const text = textOf(raw.text, `${path}.text`, EXTRACTION_LIMITS.text);
    if (!text.ok) return text;
    const when = oneOf(raw.when, KNOWLEDGE_WHENS, `${path}.when`);
    if (!when.ok) return when;
    const kind = oneOf(raw.kind, KNOWLEDGE_KINDS, `${path}.kind`);
    if (!kind.ok) return kind;
    const origin = oneOf(raw.origin, KNOWLEDGE_ORIGINS, `${path}.origin`);
    if (!origin.ok) return origin;
    const about = raw.about === undefined ? [] : raw.about;
    if (!Array.isArray(about)) return problem(`${path}.about`, 'Expected a list of stickies.');
    const perspective = typeof raw.perspective === 'string' && raw.perspective.trim() ? raw.perspective.trim().slice(0, 100) : undefined;
    return ok({
        title: title.value,
        text: text.value,
        when: when.value,
        kind: kind.value,
        origin: origin.value,
        ...(perspective && { perspective }),
        about: about.filter((a): a is string => typeof a === 'string').slice(0, EXTRACTION_LIMITS.about),
    });
}

function readSources(raw: unknown, path: string): Read<readonly ReplySource[]> {
    if (!Array.isArray(raw) || raw.length === 0) return problem(path, 'Expected at least one source.');
    const sources: ReplySource[] = [];
    for (const [i, s] of raw.slice(0, EXTRACTION_LIMITS.sources).entries()) {
        if (!isObject(s) || typeof s.message !== 'string') return problem(`${path}[${i}]`, 'Expected { message, quote }.');
        const quote = textOf(s.quote, `${path}[${i}].quote`, EXTRACTION_LIMITS.quote);
        if (!quote.ok) return quote;
        sources.push({ message: s.message, quote: quote.value });
    }
    return ok(sources);
}

function readOperation(raw: unknown, path: string): Read<ReplyOperation> {
    if (!isObject(raw)) return problem(path, 'Expected an object.');
    const op = oneOf(raw.op, OPS, `${path}.op`);
    if (!op.ok) return op;
    const reason = textOf(raw.reason, `${path}.reason`, EXTRACTION_LIMITS.reason);
    if (!reason.ok) return reason;
    const item = (): Read<string> => (typeof raw.item === 'string' && raw.item ? ok(raw.item) : problem(`${path}.item`, 'Expected the item (`k…`).'));
    switch (op.value) {
        case 'add': {
            const finding = readFinding(raw, path);
            if (!finding.ok) return finding;
            const sources = readSources(raw.sources, `${path}.sources`);
            if (!sources.ok) return sources;
            return ok({ op: 'add', finding: finding.value, sources: sources.value, reason: reason.value });
        }
        case 'addSource': {
            const target = item();
            if (!target.ok) return target;
            const sources = readSources(raw.sources, `${path}.sources`);
            if (!sources.ok) return sources;
            return ok({ op: 'addSource', item: target.value, sources: sources.value, agreed: raw.agreed === true, reason: reason.value });
        }
        case 'update': {
            const target = item();
            if (!target.ok) return target;
            const finding = readFinding(raw, path);
            if (!finding.ok) return finding;
            // the message(s) it rests on: an update without one cannot be followed to the talk (ADR 0031, section 3)
            const sources = readSources(raw.sources, `${path}.sources`);
            if (!sources.ok) return sources;
            return ok({ op: 'update', item: target.value, finding: finding.value, sources: sources.value, reason: reason.value });
        }
        case 'conflict': {
            const target = item();
            if (!target.ok) return target;
            const finding = readFinding(raw, path);
            if (!finding.ok) return finding;
            const sources = readSources(raw.sources, `${path}.sources`);
            if (!sources.ok) return sources;
            return ok({ op: 'conflict', item: target.value, finding: finding.value, sources: sources.value, reason: reason.value });
        }
        case 'retire': {
            const target = item();
            if (!target.ok) return target;
            const retirement = oneOf(raw.retirement, RETIREMENT_REASONS, `${path}.retirement`);
            if (!retirement.ok) return retirement;
            const decisions = Array.isArray(raw.decisions)
                ? raw.decisions.filter((d): d is string => typeof d === 'string').slice(0, EXTRACTION_LIMITS.sources)
                : [];
            // the evidence: the messages, the decisions, or both (a proposal always has some)
            const none: readonly ReplySource[] = [];
            const sources: Read<readonly ReplySource[]> =
                raw.sources === undefined && decisions.length > 0 ? ok(none) : readSources(raw.sources, `${path}.sources`);
            if (!sources.ok) return sources;
            const replacedBy = typeof raw.replacedBy === 'string' && raw.replacedBy ? raw.replacedBy : undefined;
            return ok({
                op: 'retire',
                item: target.value,
                retirement: retirement.value,
                ...(replacedBy && { replacedBy }),
                decisions,
                sources: sources.value,
                reason: reason.value,
            });
        }
        case 'unretire': {
            const target = item();
            if (!target.ok) return target;
            const sources = readSources(raw.sources, `${path}.sources`);
            if (!sources.ok) return sources;
            return ok({ op: 'unretire', item: target.value, sources: sources.value, reason: reason.value });
        }
    }
}

/**
 * The extractor's JSON read: refused whole unless it is `{ operations: [...] }`; each operation read on its own, the
 * malformed ones dropped with why (and those past `EXTRACTION_LIMITS.operations`).
 */
export function readExtractorReply(raw: unknown): Result<ExtractorReply, ReplyProblem> {
    if (!isObject(raw)) return problem('reply', 'Expected an object.');
    if (!Array.isArray(raw.operations)) return problem('reply.operations', 'Expected a list of operations.');
    const operations: ReplyOperation[] = [];
    const rejected: ReplyProblem[] = [];
    for (const [i, o] of raw.operations.entries()) {
        if (i >= EXTRACTION_LIMITS.operations) {
            rejected.push({ path: `reply.operations[${i}]`, message: `More than ${EXTRACTION_LIMITS.operations} operations.` });
            continue;
        }
        const read = readOperation(o, `reply.operations[${i}]`);
        if (read.ok) operations.push(read.value);
        else rejected.push(read.error);
    }
    return ok({ operations, rejected });
}

// ---- the reply made into operations ----------------------------------------------------------------------------------

/** 64-bit FNV-1a, for the IDs of new items. */
function fnv1a64(text: string): bigint {
    let h = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) {
        h ^= BigInt(byte);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h;
}

/** The ID of the new item of the operation at `index` of extraction `number` of `session`: the same each time. */
export function extractedItemId(session: string, number: number, index: number): Knowledge.KnowledgeItemId {
    const made = Knowledge.makeKnowledgeItemId(`kn_${fnv1a64(`${session}\u0000${number}\u0000${index}`).toString(36).padStart(13, '0')}`);
    // 13 characters of [0-9a-z] after `kn_`: an item ID by its pattern
    if (!made.ok) throw new Error('An extracted item ID is not an item ID');
    return made.value;
}

const spaced = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The operations of a reply, and the operations (or parts) dropped with why. */
export interface ExtractedOperations {
    readonly operations: readonly Knowledge.Operation[];
    readonly rejected: readonly ReplyProblem[];
}

/** Makes the reply's operations, over what the extraction was given (its keys resolved, its IDs made, its quotes checked). */
export function operationsOf(reply: ExtractorReply, input: ExtractionInput): ExtractedOperations {
    const messages = new Map(input.messages.map((m) => [m.key, m]));
    const items = new Map(input.items.map((i) => [i.key, i]));
    const stickies = new Set([
        ...input.stickies.map((s) => s.ref),
        ...(input.workspaceStickies ?? []).map((s) => s.ref),
        ...input.items.flatMap((i) => i.about),
    ]);
    const operations: Knowledge.Operation[] = [];
    const rejected: ReplyProblem[] = [...reply.rejected];
    const session = Knowledge.makeSessionRef(input.session);
    if (!session.ok) return { operations, rejected: [...rejected, { path: 'input.session', message: 'Not a session.' }] };

    const sourceOf = (s: ReplySource, path: string): Read<Knowledge.Source> => {
        const message = messages.get(s.message);
        if (!message) return problem(path, `No message ${s.message} was given.`);
        const id = Knowledge.makeMessageRef(message.id);
        const at = new Date(message.at);
        if (!id.ok || Number.isNaN(at.getTime())) return problem(path, `Message ${s.message} cannot be a source.`);
        const said = spaced(message.text);
        const given = spaced(s.quote);
        const fallback = said.length > EXTRACTION_LIMITS.fallbackQuote ? `${said.slice(0, EXTRACTION_LIMITS.fallbackQuote)}…` : said;
        const quote = Knowledge.makeQuote(given && said.includes(given) ? given : fallback);
        if (!quote.ok) return problem(path, `Message ${s.message} has no text to quote.`);
        return ok({ session: session.value, message: id.value, at, quote: quote.value });
    };
    const sourcesOf = (given: readonly ReplySource[], path: string): Read<readonly [Knowledge.Source, ...Knowledge.Source[]]> => {
        const seen = new Set<string>();
        const out: Knowledge.Source[] = [];
        for (const [i, s] of given.entries()) {
            const source = sourceOf(s, `${path}.sources[${i}]`);
            if (!source.ok) {
                rejected.push(source.error);
                continue;
            }
            if (seen.has(source.value.message)) continue;
            seen.add(source.value.message);
            out.push(source.value);
        }
        const [first, ...rest] = out;
        return first ? ok([first, ...rest]) : problem(`${path}.sources`, 'No source is a message that was given.');
    };
    const contentOf = (f: ReplyFinding, path: string): Read<Knowledge.ItemContent> => {
        const title = Knowledge.makeItemTitle(f.title);
        if (!title.ok) return problem(`${path}.title`, 'Not an item title.');
        const text = Knowledge.makeItemText(f.text);
        if (!text.ok) return problem(`${path}.text`, 'Not an item text.');
        const perspective = f.perspective === undefined ? undefined : Knowledge.makePerspective(f.perspective);
        const about: Knowledge.StickyRef[] = [];
        for (const a of f.about) {
            const ref = Knowledge.makeStickyRef(a);
            if (!ref.ok || !stickies.has(a)) {
                rejected.push({ path: `${path}.about`, message: `${a} is not a sticky that was given; left out.` });
                continue;
            }
            if (!about.includes(ref.value)) about.push(ref.value);
        }
        return ok({
            title: title.value,
            text: text.value,
            labels: { when: f.when, kind: f.kind, origin: f.origin, ...(perspective?.ok && { perspective: perspective.value }) },
            about,
        });
    };
    const itemOf = (key: string, path: string): Read<{ id: Knowledge.KnowledgeItemId; base: Knowledge.ItemVersion }> => {
        const item = items.get(key);
        const id = item && Knowledge.makeKnowledgeItemId(item.id);
        const base = item && Knowledge.makeItemVersion(item.version);
        if (!id?.ok || !base?.ok) return problem(`${path}.item`, `No item ${key} was given.`);
        return ok({ id: id.value, base: base.value });
    };
    const reasonOf = (r: string): { reason?: Knowledge.Reason } => {
        const made = Knowledge.makeReason(r);
        return made.ok ? { reason: made.value } : {};
    };
    const retired = new Map((input.retired ?? []).map((r) => [r.key, r]));
    /** The messages and decisions of a proposal as its evidence: at least one. */
    const evidenceOf = (
        sources: readonly ReplySource[],
        decisions: readonly string[],
        path: string,
    ): Read<readonly [Knowledge.Evidence, ...Knowledge.Evidence[]]> => {
        const evidence: Knowledge.Evidence[] = [];
        if (sources.length > 0) {
            const made = sourcesOf(sources, path);
            if (made.ok) for (const s of made.value) evidence.push({ kind: 'Said', session: s.session, message: s.message, quote: s.quote });
        }
        for (const [i, key] of decisions.entries()) {
            const decision = items.get(key);
            const id = decision && Knowledge.makeKnowledgeItemId(decision.id);
            if (!id?.ok || decision?.kind !== 'decision') {
                rejected.push({ path: `${path}.decisions[${i}]`, message: `${key} is not a decision that was given; left out.` });
                continue;
            }
            if (!evidence.some((e) => e.kind === 'Decision' && e.item === id.value)) evidence.push({ kind: 'Decision', item: id.value });
        }
        const [first, ...rest] = evidence;
        return first ? ok([first, ...rest]) : problem(`${path}.sources`, 'A proposal rests on a message or a decision that was given.');
    };

    for (const [index, o] of reply.operations.entries()) {
        const path = `reply.operations[${index}]`;
        const fail = (p: ReplyProblem): void => void rejected.push(p);
        switch (o.op) {
            case 'add': {
                const content = contentOf(o.finding, path);
                if (!content.ok) fail(content.error);
                const sources = content.ok ? sourcesOf(o.sources, path) : undefined;
                if (sources && !sources.ok) fail(sources.error);
                if (!content.ok || !sources?.ok) break;
                const id = extractedItemId(input.session, input.number, index);
                operations.push({ kind: 'Add', id, content: content.value, sources: sources.value, ...reasonOf(o.reason) });
                break;
            }
            case 'addSource': {
                const item = itemOf(o.item, path);
                if (!item.ok) {
                    fail(item.error);
                    break;
                }
                const sources = sourcesOf(o.sources, path);
                if (!sources.ok) {
                    fail(sources.error);
                    break;
                }
                for (const source of sources.value)
                    operations.push({ kind: 'AddSource', item: item.value.id, base: item.value.base, source, agreed: o.agreed, ...reasonOf(o.reason) });
                break;
            }
            case 'update': {
                const item = itemOf(o.item, path);
                if (!item.ok) {
                    fail(item.error);
                    break;
                }
                const revised = contentOf(o.finding, path);
                if (!revised.ok) {
                    fail(revised.error);
                    break;
                }
                const sources = sourcesOf(o.sources, path);
                if (!sources.ok) {
                    fail(sources.error);
                    break;
                }
                operations.push({
                    kind: 'Update',
                    item: item.value.id,
                    base: item.value.base,
                    revised: revised.value,
                    sources: sources.value,
                    ...reasonOf(o.reason),
                });
                break;
            }
            case 'conflict': {
                const item = itemOf(o.item, path);
                if (!item.ok) {
                    fail(item.error);
                    break;
                }
                const content = contentOf(o.finding, path);
                if (!content.ok) {
                    fail(content.error);
                    break;
                }
                const sources = sourcesOf(o.sources, path);
                if (!sources.ok) {
                    fail(sources.error);
                    break;
                }
                const id = extractedItemId(input.session, input.number, index);
                operations.push({
                    kind: 'Conflict',
                    id,
                    content: content.value,
                    sources: sources.value,
                    item: item.value.id,
                    base: item.value.base,
                    ...reasonOf(o.reason),
                });
                break;
            }
            case 'retire': {
                const item = itemOf(o.item, path);
                if (!item.ok) {
                    fail(item.error);
                    break;
                }
                const replacedBy = o.replacedBy === undefined ? undefined : itemOf(o.replacedBy, `${path}.replacedBy`);
                if (replacedBy && !replacedBy.ok) {
                    fail(replacedBy.error);
                    break;
                }
                const evidence = evidenceOf(o.sources, o.decisions, path);
                const why = Knowledge.makeReason(o.reason);
                if (!evidence.ok || !why.ok) {
                    fail(evidence.ok ? { path: `${path}.reason`, message: 'Not a reason.' } : evidence.error);
                    break;
                }
                operations.push({
                    kind: 'ProposeRetire',
                    item: item.value.id,
                    retirementReason: o.retirement,
                    // a replacement only for `replaced`
                    ...(replacedBy?.ok && o.retirement === 'replaced' && { replacedBy: replacedBy.value.id }),
                    evidence: evidence.value,
                    reason: why.value,
                });
                break;
            }
            case 'unretire': {
                const target = retired.get(o.item);
                const id = target && Knowledge.makeKnowledgeItemId(target.id);
                if (!id?.ok) {
                    fail({ path: `${path}.item`, message: `No retired item ${o.item} was given.` });
                    break;
                }
                const evidence = evidenceOf(o.sources, [], path);
                const why = Knowledge.makeReason(o.reason);
                if (!evidence.ok || !why.ok) {
                    fail(evidence.ok ? { path: `${path}.reason`, message: 'Not a reason.' } : evidence.error);
                    break;
                }
                operations.push({ kind: 'ProposeUnretire', item: id.value, evidence: evidence.value, reason: why.value });
                break;
            }
        }
    }
    return { operations, rejected };
}
