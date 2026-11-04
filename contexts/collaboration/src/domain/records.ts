// The session's records (記録): the small centred rows dt writes in the chat for what people do that leaves no other
// row — a goal changed, ✓ marks set or cleared, a journey marked done, archived or brought back, the current journey
// chosen, a participant's request and what became of it, an interview stopped, a participant's brief rejected — and
// for the journey file changed outside dt (git, an editor). A record keeps what happened as data (who, which journey
// by its key and its name then, which steps); its text is made here, in Japanese or English, for the page (in the
// viewer's language, as the session-start row) and for the session so far (in English).
//
// Two records are written again rather than added to:
//
// - **✓ marks merge.** A mark set or cleared extends the last record of the session when that record is the same
//   person's marks on the same journey in the same direction (set, or cleared) and nothing else came into the stream
//   after it (no message, card, proposal, command, restore or other record): 「大山 が「例外」「問い」を済みにしました」.
//   No time limit: what breaks a run of marks is something else happening.
// - **A request's outcome** is written on the request's own record (「佐藤 が…をお願いしました。大山 が承認しました」): the
//   row tells the whole request. An approved act also gets its own record, by the facilitator who did it.
//
// Pure.
import { Collaboration, decide, ok } from '../generated/index.js';
import { stepWord } from './journey-note.js';
import { defaultJourney, journeyOf, journeySummaries, type JourneyAct, type JourneyFile, type JourneyState, type JourneySummary } from './journey.js';

type Lang = Collaboration.UiLanguage;
type RecordFact = Collaboration.RecordFact;
type MarksChanged = Extract<RecordFact, { readonly kind: 'MarksChanged' }>;

export const recordCommands: Collaboration.SessionRecordCommands = {
    write: decide<Collaboration.WriteSessionRecordDecision>(Collaboration.SessionRecordShape, ({ id, session, by, fact, replyTo, at }) =>
        ok({
            Written: {
                set: { id, session, by, fact, replyTo, at, revisedAt: undefined },
                events: {
                    RecordWritten: { type: 'RecordWritten', recordId: id, session, ...(by !== undefined && { by }), fact, ...(replyTo && { replyTo }), at },
                },
            },
        }),
    ),
    revise: decide<Collaboration.ReviseSessionRecordDecision>(Collaboration.SessionRecordShape, {
        Written: (record, { fact, revisedAt }) =>
            ok({ Written: { set: { fact, revisedAt }, events: { RecordRevised: { type: 'RecordRevised', recordId: record.id, fact, revisedAt } } } }),
    }),
};

// ---- What a record names ----

/** A journey's name for the records, by its key (an ES journey's: its storming's label, when the workspace has it). */
export type JourneyLabels = (key: string) => string | undefined;

const made = <T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false }): T | undefined => (r.ok ? r.value : undefined);

/** The journey a record names: its key, and its name now (the storming's label, the modeling journey's name, else the key). */
export function recordedJourney(file: JourneyFile | undefined, key: string, labels?: JourneyLabels): Collaboration.RecordedJourney | undefined {
    const journey = made(Collaboration.makeGuideJourneyKey(key));
    if (!journey) return undefined;
    const ref = file && journeyOf(file, key);
    const name = labels?.(key) ?? (ref?.kind === 'model' ? ref.entry.name : key.startsWith('es:') ? key.slice(3) : key);
    const label = made(Collaboration.makeJourneyLabel(name.slice(0, 200))) ?? made(Collaboration.makeJourneyLabel(key.slice(0, 200)));
    return label && { journey, label };
}

const stepKey = (s: string): Collaboration.GuideStepKey | undefined => made(Collaboration.makeGuideStepKey(s));

/** The file's state as the records keep it. */
const STATUS: Readonly<Record<JourneyState, Collaboration.JourneyStatus>> = { active: 'Active', done: 'Done', archived: 'Archived' };

/** A mark of an act (a BC row by its context). */
function recordedMark(step: string, context: string | undefined): Collaboration.RecordedMark | undefined {
    const key = stepKey(step);
    if (!key) return undefined;
    if (context === undefined) return { step: key };
    const name = made(Collaboration.makeContextName(context));
    return name && { step: key, context: name };
}

/** A journey's goal in the file (an ES journey's: its level). */
function goalOf(file: JourneyFile, key: string): string | undefined {
    const ref = journeyOf(file, key);
    return ref?.kind === 'es' ? ref.entry.level : ref?.entry.goal;
}

/**
 * What a person's act on the journeys records (the facilitator's own, or a participant's approved): the goal from
 * what it was in the file before, the mark, the state, or the current journey chosen. `current`: the session's current
 * journey before the act (absent: none chosen; the file's default then) — an act on another names it. Undefined when
 * there is nothing to record (the default chosen, a journey or step that is not one).
 */
export function actFact(input: {
    readonly act: JourneyAct | { readonly kind: 'choose'; readonly journey: string | null };
    /** The journey file before the act. */
    readonly before: JourneyFile | undefined;
    readonly current?: string;
    readonly labels?: JourneyLabels;
}): RecordFact | undefined {
    const { act, before, labels } = input;
    if (act.journey === null) return undefined;
    const journey = recordedJourney(before, act.journey, labels);
    if (!journey) return undefined;
    const current = before ? defaultJourney(before, input.current) : input.current;
    const other = current !== act.journey;
    switch (act.kind) {
        case 'choose':
            return { kind: 'CurrentChosen', journey };
        case 'goal': {
            const was = before && goalOf(before, act.journey);
            const from = was === undefined ? undefined : stepKey(was);
            const to = stepKey(act.goal);
            return from && to ? { kind: 'GoalChanged', journey, from, to, other } : undefined;
        }
        case 'state':
            return { kind: 'StateChanged', journey, state: STATUS[act.state] };
        case 'mark': {
            const mark = recordedMark(act.step, act.context);
            return mark && { kind: 'MarksChanged', journey, done: act.done, marks: [mark], other };
        }
    }
}

/** A participant's request as its record keeps it (the journey by its name then). */
export function requestedAct(
    act: JourneyAct | { readonly kind: 'choose'; readonly journey: string | null },
    file: JourneyFile | undefined,
    labels?: JourneyLabels,
): Collaboration.RequestedJourneyAct | undefined {
    if (act.journey === null) return { kind: 'Choose' };
    const journey = recordedJourney(file, act.journey, labels);
    if (!journey) return undefined;
    switch (act.kind) {
        case 'choose':
            return { kind: 'Choose', journey };
        case 'goal': {
            const goal = stepKey(act.goal);
            return goal && { kind: 'Goal', journey, goal };
        }
        case 'state':
            return { kind: 'State', journey, state: STATUS[act.state] };
        case 'mark': {
            const mark = recordedMark(act.step, act.context);
            return mark && { kind: 'Mark', journey, mark, done: act.done };
        }
    }
}

/** A request's act as the server keeps it (`JourneyRequestAct`), from its record. */
export function journeyActOf(act: Collaboration.RequestedJourneyAct): JourneyAct | { readonly kind: 'choose'; readonly journey: string | null } {
    const state = (s: Collaboration.JourneyStatus): JourneyState => (s === 'Active' ? 'active' : s === 'Done' ? 'done' : 'archived');
    switch (act.kind) {
        case 'Choose':
            return { kind: 'choose', journey: act.journey?.journey ?? null };
        case 'Goal':
            return { kind: 'goal', journey: act.journey.journey, goal: act.goal };
        case 'State':
            return { kind: 'state', journey: act.journey.journey, state: state(act.state) };
        case 'Mark':
            return {
                kind: 'mark',
                journey: act.journey.journey,
                step: act.mark.step,
                ...(act.mark.context !== undefined && { context: act.mark.context }),
                done: act.done,
            };
    }
}

// ---- The ✓ merge ----

const sameMark = (a: Collaboration.RecordedMark, b: Collaboration.RecordedMark): boolean => a.step === b.step && a.context === b.context;

/**
 * The ✓ merge: the marks of `fact` added to `last` when `last` is the same person's marks on the same journey in the
 * same direction and nothing came into the stream after it (`later`: something did). Undefined: a record of its own.
 */
export function mergedMarks(
    last: Pick<Collaboration.SessionRecord, 'by' | 'fact'> | undefined,
    by: string,
    fact: MarksChanged,
    later: boolean,
): MarksChanged | undefined {
    if (!last || later || last.by !== by || last.fact.kind !== 'MarksChanged') return undefined;
    const was = last.fact;
    if (was.journey.journey !== fact.journey.journey || was.done !== fact.done) return undefined;
    const added = fact.marks.filter((m) => !was.marks.some((x) => sameMark(x, m)));
    const [first, ...rest] = [...was.marks, ...added].slice(0, 40);
    return first ? { ...was, marks: [first, ...rest] } : undefined;
}

// ---- The journey file changed outside dt ----

/** The most changes a record names; the rest are counted. */
export const MAX_FILE_CHANGES = 10;

const briefKey = (s: JourneySummary): string =>
    JSON.stringify([s.name, s.purpose, s.scope, s.constraints, s.participants, s.use, s.pattern, s.stormings, s.context]);

/** The marks of a journey in the file, as one comparable value. */
function marksKey(file: JourneyFile, key: string): string {
    const ref = journeyOf(file, key);
    return ref ? JSON.stringify(ref.entry.marks) : '';
}

/**
 * What changed in the journey file between two versions, in a few words: journeys added or removed, goals, states,
 * marks, briefs — in the file's order, the first `MAX_FILE_CHANGES` named and the rest counted. A file removed reads as
 * every journey removed.
 */
export function journeyFileChanges(
    before: JourneyFile | undefined,
    after: JourneyFile | undefined,
    labels?: JourneyLabels,
): { readonly changes: readonly Collaboration.JourneyFileChange[]; readonly more: number } {
    const was = new Map((before ? journeySummaries(before) : []).map((s) => [s.key, s]));
    const now = new Map((after ? journeySummaries(after) : []).map((s) => [s.key, s]));
    const all: Collaboration.JourneyFileChange[] = [];
    const named = (file: JourneyFile | undefined, key: string): Collaboration.RecordedJourney | undefined => recordedJourney(file, key, labels);
    const push = (kind: Collaboration.JourneyFileChangeKind, journey: Collaboration.RecordedJourney | undefined, from?: string, to?: string): void => {
        if (journey) all.push({ kind, journey, ...(from !== undefined && { from }), ...(to !== undefined && { to }) });
    };
    for (const [key, s] of now) {
        const w = was.get(key);
        const journey = named(after, key);
        if (!w) {
            push('Added', journey);
            continue;
        }
        if (w.goal !== s.goal) push('Goal', journey, w.goal, s.goal);
        if (w.state !== s.state) push('State', journey, STATUS[w.state], STATUS[s.state]);
        if (before && after && marksKey(before, key) !== marksKey(after, key)) push('Marks', journey);
        if (briefKey(w) !== briefKey(s)) push('Brief', journey);
    }
    for (const key of was.keys()) if (!now.has(key)) push('Removed', named(before, key));
    return { changes: all.slice(0, MAX_FILE_CHANGES), more: Math.max(0, all.length - MAX_FILE_CHANGES) };
}

// ---- The text ----

interface RecordWords {
    readonly quote: (s: string) => string;
    readonly list: string;
    readonly status: Readonly<Record<Collaboration.JourneyStatus, string>>;
    readonly goal: (by: string, journey: string | undefined, from: string, to: string) => string;
    readonly marks: (by: string, journey: string | undefined, marks: string, done: boolean) => string;
    readonly state: (by: string, journey: string, state: Collaboration.JourneyStatus) => string;
    readonly chosen: (by: string, journey: string) => string;
    readonly asks: Readonly<{
        choose: (journey: string | undefined) => string;
        goal: (journey: string, goal: string) => string;
        state: (journey: string, state: Collaboration.JourneyStatus) => string;
        mark: (journey: string, mark: string, done: boolean) => string;
    }>;
    readonly requested: (by: string, act: string) => string;
    readonly decided: (by: string, act: string, outcome: Collaboration.JourneyRequestOutcome, decider: string) => string;
    readonly stopped: (by: string) => string;
    readonly rejected: (by: string, note: string | undefined) => string;
    readonly outside: (what: string | undefined) => string;
    readonly change: (change: Collaboration.JourneyFileChange, step: (key: string) => string) => string;
    readonly more: (n: number) => string;
    readonly unreadable: string;
}

/** A state's word, by its name as a file change keeps it (`JourneyStatus`). */
const statusWord = (w: RecordWords, state: string | undefined): string =>
    state === 'Active' || state === 'Done' || state === 'Archived' ? w.status[state] : (state ?? '');

const JA: RecordWords = {
    quote: (s) => `「${s}」`,
    list: '、',
    status: { Active: '進行中', Done: '完了', Archived: 'しまった' },
    goal: (by, journey, from, to) => `${by} が${journey === undefined ? '' : `「${journey}」の`}ゴールを ${from} → ${to} に変えました`,
    marks: (by, journey, marks, done) =>
        `${by} が${journey === undefined ? '' : `「${journey}」の`}${marks}${done ? 'を済みにしました' : 'の済みを外しました'}`,
    state: (by, journey, state) => `${by} が「${journey}」を${state === 'Done' ? '完了にしました' : state === 'Archived' ? 'しまいました' : '戻しました'}`,
    chosen: (by, journey) => `${by} がいまのジャーニーを「${journey}」にしました`,
    asks: {
        choose: (journey) => (journey === undefined ? 'いまのジャーニーを決めないよう' : `いまのジャーニーを「${journey}」にするよう`),
        goal: (journey, goal) => `「${journey}」のゴールを ${goal} にするよう`,
        state: (journey, state) => `「${journey}」を${state === 'Done' ? '完了にする' : state === 'Archived' ? 'しまう' : '戻す'}よう`,
        mark: (journey, mark, done) => `「${journey}」の${mark}${done ? 'を済みにする' : 'の済みを外す'}よう`,
    },
    requested: (by, act) => `${by} が${act}お願いしています`,
    decided: (by, act, outcome, decider) =>
        `${by} が${act}お願いしました。${decider} が${outcome === 'Approved' ? '承認しました' : outcome === 'Denied' ? '却下しました' : '取り下げました'}`,
    stopped: (by) => `${by} が中止しました`,
    rejected: (by, note) => (note === undefined ? `${by} が却下しました` : `${by} が却下しました（${note}）`),
    outside: (what) => (what === undefined ? 'ジャーニーファイルが外で変わりました' : `ジャーニーファイルが外で変わりました（${what}）`),
    change: (c, step) => {
        const j = `「${c.journey.label}」`;
        switch (c.kind) {
            case 'Added':
                return `${j}が増えた`;
            case 'Removed':
                return `${j}がなくなった`;
            case 'Goal':
                return `${j}のゴール ${step(c.from ?? '')} → ${step(c.to ?? '')}`;
            case 'State':
                return `${j}が${statusWord(JA, c.to)}`;
            case 'Marks':
                return `${j}の済み`;
            case 'Brief':
                return `${j}のブリーフ`;
        }
    },
    more: (n) => `ほか ${n} 件`,
    unreadable: '読めません',
};

const EN: RecordWords = {
    quote: (s) => `“${s}”`,
    list: ', ',
    status: { Active: 'active', Done: 'done', Archived: 'archived' },
    goal: (by, journey, from, to) => `${by} changed the goal${journey === undefined ? '' : ` of “${journey}”`}: ${from} → ${to}`,
    marks: (by, journey, marks, done) =>
        `${by} ${done ? 'marked' : 'unmarked'} ${marks}${done ? ' done' : ''}${journey === undefined ? '' : ` in “${journey}”`}`,
    state: (by, journey, state) =>
        `${by} ${state === 'Done' ? 'marked' : state === 'Archived' ? 'archived' : 'restored'} “${journey}”${state === 'Done' ? ' complete' : ''}`,
    chosen: (by, journey) => `${by} made “${journey}” the current journey`,
    asks: {
        choose: (journey) => (journey === undefined ? 'leave the current journey to the default' : `make “${journey}” the current journey`),
        goal: (journey, goal) => `set the goal of “${journey}” to ${goal}`,
        state: (journey, state) =>
            `${state === 'Done' ? 'mark' : state === 'Archived' ? 'archive' : 'restore'} “${journey}”${state === 'Done' ? ' complete' : ''}`,
        mark: (journey, mark, done) => `${done ? 'mark' : 'unmark'} ${mark}${done ? ' done' : ''} in “${journey}”`,
    },
    requested: (by, act) => `${by} asks to ${act}`,
    decided: (by, act, outcome, decider) =>
        outcome === 'Withdrawn'
            ? `${by} asked to ${act}; ${decider} withdrew it`
            : `${by} asked to ${act}; ${decider} ${outcome === 'Approved' ? 'approved' : 'denied'} it`,
    stopped: (by) => `${by} stopped it`,
    rejected: (by, note) => (note === undefined ? `${by} rejected the brief` : `${by} rejected the brief (${note})`),
    outside: (what) => (what === undefined ? 'The journey file changed outside dt' : `The journey file changed outside dt (${what})`),
    change: (c, step) => {
        const j = `“${c.journey.label}”`;
        switch (c.kind) {
            case 'Added':
                return `added ${j}`;
            case 'Removed':
                return `removed ${j}`;
            case 'Goal':
                return `goal of ${j}: ${step(c.from ?? '')} → ${step(c.to ?? '')}`;
            case 'State':
                return `${j} ${statusWord(EN, c.to)}`;
            case 'Marks':
                return `marks of ${j}`;
            case 'Brief':
                return `brief of ${j}`;
        }
    },
    more: (n) => `${n} more`,
    unreadable: 'it does not read',
};

const wordsOf = (language: Lang): RecordWords => (language === 'En' ? EN : JA);

/** A mark's name: its step's, or a BC row's context. */
const markName = (language: Lang, m: Collaboration.RecordedMark): string => m.context ?? stepWord(language, m.step);

/**
 * A record's text in a language: who did what, in a few words. `nameOf`: a participant's name now (as the chat names
 * the authors of messages).
 */
export function recordText(record: Pick<Collaboration.SessionRecord, 'by' | 'fact'>, language: Lang, nameOf: (participant: string) => string): string {
    const w = wordsOf(language);
    const step = (key: string): string => stepWord(language, key);
    const by = record.by === undefined ? '' : nameOf(record.by);
    const f = record.fact;
    switch (f.kind) {
        case 'GoalChanged':
            return w.goal(by, f.other ? f.journey.label : undefined, step(f.from), step(f.to));
        case 'MarksChanged':
            return w.marks(
                by,
                f.other ? f.journey.label : undefined,
                f.marks.map((m) => w.quote(markName(language, m))).join(language === 'En' ? ', ' : ''),
                f.done,
            );
        case 'StateChanged':
            return w.state(by, f.journey.label, f.state);
        case 'CurrentChosen':
            return w.chosen(by, f.journey.label);
        case 'JourneyRequested': {
            const a = f.act;
            const act =
                a.kind === 'Choose'
                    ? w.asks.choose(a.journey?.label)
                    : a.kind === 'Goal'
                      ? w.asks.goal(a.journey.label, step(a.goal))
                      : a.kind === 'State'
                        ? w.asks.state(a.journey.label, a.state)
                        : w.asks.mark(a.journey.label, w.quote(markName(language, a.mark)), a.done);
            if (f.outcome === undefined) return w.requested(by, act);
            return w.decided(by, act, f.outcome, f.decidedBy === undefined ? by : nameOf(f.decidedBy));
        }
        case 'InterviewStopped':
            return w.stopped(by);
        case 'BriefRejected':
            return w.rejected(by, f.note);
        case 'FileChangedOutside': {
            const parts = [...f.changes.map((c) => w.change(c, step)), ...(f.more > 0 ? [w.more(f.more)] : []), ...(f.unreadable ? [w.unreadable] : [])];
            return w.outside(parts.length === 0 ? undefined : parts.join(w.list));
        }
    }
}

/** Whether a record still waits for something: a request not decided yet. */
export const isOpenRequest = (record: Pick<Collaboration.SessionRecord, 'fact'>): boolean =>
    record.fact.kind === 'JourneyRequested' && record.fact.outcome === undefined;
