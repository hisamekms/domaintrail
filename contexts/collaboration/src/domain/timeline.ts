// The session so far (ADR 0030; the plan's "The session so far", decided in round 3): what the agents are given about
// the session besides the files, built mechanically from the session's records — no AI summary, so it is the same each
// time and survives restarts. It is the chat as the page shows it plus what the chat alone does not say:
//
// - people's messages (who, the body, what they reply to, their targets) and the AI's answers;
// - each AI turn in a few lines: which messages, the outcome (completed, unchanged, answered, needs clarification,
//   failed, declined, cancelled, reverted), its title and summary, what it changed (elements when known, else files;
//   never the diff), its assumptions and how each was decided;
// - events: proposals made, approved (edited), rejected (with the note) or withdrawn; interviews (`/es:start`,
//   `/model:start`) started, their brief, confirmed (with its run) or stopped; the other `/` commands started, their
//   candidates, those applied (with the run) or the command stopped; restores; files changed outside the session (a
//   snapshot whose content differs from the revision before it);
// - what is open now: the AI's questions awaiting an answer, the proposals awaiting approval, a running interview or
//   command, the messages waiting for the AI, the queue.
//
// Entries are numbered in time order; an AI turn is placed when it ended (a queued or running one is "open now"), so the
// list only grows and a warm agent can be given only the entries after the last one it saw (`since`). Limits: the newest
// `full` entries in full, the `lines` before them one line each, the older ones only counted.
//
// Pure. The text is data for the agents: their prompts put it in a delimited block they are told not to obey.
import type { Collaboration } from '../generated/index.js';
import { isAi, AI_NAME } from './ai.js';
import { approvalOf } from './approvals.js';
import { plainBody } from './body.js';
import { compareFiles } from './compare.js';
import { laterRunOf } from './marks.js';
import { briefLines, commandId } from './interviews.js';
import { elementReference } from './proposals.js';
import { slashCommandName } from './slash-commands.js';
import { revertStatus } from './revert.js';

/** The limits of the timeline: the newest entries in full, then one line each, the rest counted (configurable later). */
export const TIMELINE_LIMITS = { full: 30, lines: 100 } as const;

/** The most characters of an entry's one-line form, and of a body inside a full entry. */
const LINE_CHARS = 160;
const BODY_CHARS = 2000;

/** The records the timeline is built from: a session's state. */
export interface TimelineRecords {
    readonly session: Collaboration.Session;
    readonly requests: readonly Collaboration.Request[];
    readonly runs: readonly Collaboration.AgentRun[];
    readonly revisions: readonly Collaboration.Revision[];
    readonly approvals: readonly Collaboration.AssumptionApproval[];
    readonly proposals: readonly Collaboration.ChangeProposal[];
    readonly triages: readonly Collaboration.Triage[];
    /** The interviews of the `/` commands (absent: none). */
    readonly interviews?: readonly Collaboration.Interview[];
    /** The candidate and answer commands of the `/` list (absent: none). */
    readonly slashCommands?: readonly Collaboration.SlashCommand[];
    /**
     * What a run changed in the model's words (element names, by run ID), when the caller measured it; a run without
     * one is told by the files its revisions differ by.
     */
    readonly elementChanges?: ReadonlyMap<string, readonly string[]>;
}

export type TimelineEntryKind = 'message' | 'answer' | 'turn' | 'proposal' | 'interview' | 'command' | 'restore' | 'external';

/** One entry of the timeline: its number (from 1, in time order), when, and its full and one-line texts. */
export interface TimelineEntry {
    readonly index: number;
    readonly at: Date;
    readonly kind: TimelineEntryKind;
    readonly full: string;
    readonly line: string;
}

/** The timeline as an agent gets it. */
export interface SessionSoFar {
    /** The text: the entries within the limits and what is open now. */
    readonly text: string;
    /** The entries given in full and as lines (`since`: only those after it). */
    readonly entries: readonly TimelineEntry[];
    /** How many entries were left out, only counted. */
    readonly omitted: number;
    /** The number of the last entry: the `since` of the next call for a warm agent. */
    readonly last: number;
    /** What is open now, one line each. */
    readonly open: readonly string[];
}

const time = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const oneLine = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** The time a run ended (or was cancelled), if it did. */
function endedAt(run: Collaboration.AgentRun): Date | undefined {
    switch (run.state) {
        case 'Queued':
        case 'Running':
            return undefined;
        case 'Cancelled':
            return run.cancelledAt;
        default:
            return run.finishedAt;
    }
}

interface Draft {
    readonly at: Date;
    readonly kind: TimelineEntryKind;
    /** What the entry is about, so that other entries can name it by its number. */
    readonly key: string;
    readonly render: (ref: Ref) => { readonly full: string; readonly line: string };
}

/** Every entry of the session, in time order, numbered from 1. */
export const timelineEntries = (records: TimelineRecords): TimelineEntry[] => numbered(records).entries;

/** How an entry names another: `#n`, by what the other is about (`request:<id>`, `run:<id>`, `proposal:<id>`). */
type Ref = (key: string) => string | undefined;

/** The entries, and how to name each by what it is about. */
function numbered(records: TimelineRecords): { readonly entries: TimelineEntry[]; readonly ref: Ref } {
    // approvals are told with their turn (how its assumptions were decided): no entry of their own
    const { session, requests, runs, revisions, proposals } = records;
    const names = new Map<string, string>(session.participants.map((p) => [p.id, p.name]));
    const nameOf = (id: string): string => (isAi(id) ? AI_NAME : (names.get(id) ?? 'a participant'));
    const messages = (ids: readonly string[], ref: Ref): string => ids.map((id) => ref(`request:${id}`) ?? 'a message').join(', ');
    const drafts: Draft[] = [];

    for (const r of requests) {
        const ai = isAi(r.author);
        drafts.push({
            at: r.sentAt,
            kind: ai ? 'answer' : 'message',
            key: `request:${r.id}`,
            render: (ref) => {
                const to = r.replyTo;
                const replying =
                    to === undefined
                        ? ''
                        : to.kind === 'Run'
                          ? ` (replying to ${ref(`run:${to.run}`) ?? 'an AI turn'})`
                          : ` (replying to ${ref(`request:${to.request}`) ?? 'a message'})`;
                const targets = r.targets.map((t) => t.label ?? targetName(t.target));
                const about = targets.length ? ` about ${targets.join(', ')}` : '';
                const body = plainBody(r.body);
                const who = ai ? `${AI_NAME} answered` : nameOf(r.author);
                return {
                    full: `${who}${replying}${about}:\n${indent(cut(body, BODY_CHARS))}`,
                    line: `${who}${replying}: ${cut(oneLine(body), LINE_CHARS)}`,
                };
            },
        });
    }

    for (const run of runs) {
        const at = endedAt(run);
        if (!at) continue;
        drafts.push({ at, kind: 'turn', key: `run:${run.id}`, render: (ref) => turn(run, records, ref, messages) });
    }

    for (const p of proposals) {
        drafts.push({
            at: p.proposedAt,
            kind: 'proposal',
            key: `proposal:${p.id}`,
            render: (ref) => {
                const of = ref(`request:${p.request}`) ?? 'a message';
                return {
                    full: `${AI_NAME} proposed a change for ${of} (by ${nameOf(p.requestedBy)}):\n${indent(content(p.content))}`,
                    line: `${AI_NAME} proposed a change for ${of}: ${cut(oneLine(p.content.how), LINE_CHARS)}`,
                };
            },
        });
        const decided =
            p.state === 'Approved'
                ? {
                      at: p.approvedAt,
                      text: `approved by ${nameOf(p.approvedBy)}${chosenLabel(p) ? ` with the option "${chosenLabel(p)}"` : ''}${p.editedHow ? ' after editing its how' : ''}`,
                  }
                : p.state === 'Rejected'
                  ? { at: p.rejectedAt, text: `rejected by ${nameOf(p.rejectedBy)}${p.note ? `: ${oneLine(p.note)}` : ''}` }
                  : p.state === 'Withdrawn'
                    ? { at: p.withdrawnAt, text: `withdrawn by ${nameOf(p.requestedBy)}` }
                    : undefined;
        if (!decided) continue;
        drafts.push({
            at: decided.at,
            kind: 'proposal',
            key: `proposal-decided:${p.id}`,
            render: (ref) => {
                const line = `The proposal ${ref(`proposal:${p.id}`) ?? ''} was ${decided.text}`.replace('  ', ' ');
                const edited = p.state === 'Approved' && p.editedHow ? `\n${indent(`how edited to: ${p.editedHow}`)}` : '';
                const run = p.state === 'Approved' ? ` (${ref(`run:${p.run}`) ?? 'its run is in the queue'})` : '';
                return { full: `${line}${run}${edited}`, line: cut(line, LINE_CHARS) };
            },
        });
    }

    for (const i of records.interviews ?? []) {
        const what = `the interview /${commandId(i.command)}`;
        drafts.push({
            at: i.startedAt,
            kind: 'interview',
            key: `interview:${i.id}`,
            render: (ref) => {
                const line = `${nameOf(i.startedBy)} started ${what} (${ref(`request:${i.opening}`) ?? 'its opening message'}): the AI asks, ${nameOf(i.startedBy)}'s messages answer it`;
                return { full: line, line: cut(line, LINE_CHARS) };
            },
        });
        const brief = i.state === 'Briefed' || i.state === 'Confirmed' ? i.brief : undefined;
        if (brief && i.state === 'Briefed')
            drafts.push({
                at: i.briefedAt,
                kind: 'interview',
                key: `interview-brief:${i.id}`,
                render: () => ({
                    full: `${AI_NAME} wrote the brief of ${what}, waiting for ${nameOf(i.startedBy)} to confirm it:\n${indent(briefOf(brief))}`,
                    line: cut(`${AI_NAME} wrote the brief of ${what} for ${brief.name}`, LINE_CHARS),
                }),
            });
        if (i.state === 'Confirmed')
            drafts.push({
                at: i.confirmedAt,
                kind: 'interview',
                key: `interview-confirmed:${i.id}`,
                render: (ref) => ({
                    full: `${nameOf(i.startedBy)} confirmed the brief of ${what}${i.edited ? ' after editing it' : ''} (${ref(`run:${i.run}`) ?? 'its run is in the queue'}):\n${indent(briefOf(i.brief))}`,
                    line: cut(`${nameOf(i.startedBy)} confirmed the brief of ${what} for ${i.brief.name}`, LINE_CHARS),
                }),
            });
        if (i.state === 'Stopped')
            drafts.push({
                at: i.stoppedAt,
                kind: 'interview',
                key: `interview-stopped:${i.id}`,
                render: () => {
                    const line = `${nameOf(i.stoppedBy)} stopped ${what}`;
                    return { full: line, line };
                },
            });
    }

    for (const c of records.slashCommands ?? []) {
        const what = `/${slashCommandName(c.kind)}`;
        drafts.push({
            at: c.startedAt,
            kind: 'command',
            key: `command:${c.id}`,
            render: (ref) => {
                const line = `${nameOf(c.startedBy)} ran ${what}${c.scope ? ` on @{es:${c.scope}}` : ''} (${ref(`request:${c.opening}`) ?? 'its opening message'})`;
                return { full: line, line: cut(line, LINE_CHARS) };
            },
        });
        const candidates = c.state === 'Listed' || c.state === 'Applied' ? c.candidates : undefined;
        if (candidates && c.state === 'Listed')
            drafts.push({
                at: c.listedAt,
                kind: 'command',
                key: `command-listed:${c.id}`,
                render: () => ({
                    full: `${AI_NAME} listed ${candidates.length} candidate(s) for ${what}, waiting for ${nameOf(c.startedBy)} to choose:${candidates.length ? `\n${indent(candidates.map(candidateOf).join('\n'))}` : ''}`,
                    line: cut(`${AI_NAME} listed ${candidates.length} candidate(s) for ${what}`, LINE_CHARS),
                }),
            });
        if (c.state === 'Applied') {
            const chosen = c.chosen.flatMap((i) => c.candidates[i] ?? []);
            drafts.push({
                at: c.appliedAt,
                kind: 'command',
                key: `command-applied:${c.id}`,
                render: (ref) => ({
                    full: `${nameOf(c.startedBy)} applied ${chosen.length} of the ${c.candidates.length} candidates of ${what} (${ref(`run:${c.run}`) ?? 'its run is in the queue'}):\n${indent(chosen.map(candidateOf).join('\n'))}`,
                    line: cut(`${nameOf(c.startedBy)} applied ${chosen.map((x) => x.label).join(', ')} from ${what}`, LINE_CHARS),
                }),
            });
        }
        if (c.state === 'Stopped')
            drafts.push({
                at: c.stoppedAt,
                kind: 'command',
                key: `command-stopped:${c.id}`,
                render: () => {
                    const line = `${nameOf(c.stoppedBy)} stopped ${what}`;
                    return { full: line, line };
                },
            });
    }

    let previous: Collaboration.Revision | undefined;
    for (const rev of revisions) {
        const before = previous;
        previous = rev;
        if (rev.origin.kind === 'Restored') {
            const from = rev.origin.restoredFrom;
            drafts.push({
                at: rev.takenAt,
                kind: 'restore',
                key: `revision:${rev.id}`,
                render: () => {
                    const line = `The facilitator restored the workspace to an earlier revision (${revisionName(revisions.find((r) => r.id === from))})`;
                    return { full: line, line };
                },
            });
            continue;
        }
        // a snapshot taken by the session itself whose content differs from the revision before: edits made outside
        if (!before || before.contentHash === rev.contentHash) continue;
        if (rev.origin.kind !== 'RunBase' && rev.origin.kind !== 'Manual' && rev.origin.kind !== 'PreRestore') continue;
        const paths = compareFiles(before.files, rev.files)
            .filter((f) => f.status !== 'unchanged')
            .map((f) => `${f.path} (${f.status})`);
        drafts.push({
            at: rev.takenAt,
            kind: 'external',
            key: `revision:${rev.id}`,
            render: () => ({
                full: `Files changed outside the session: ${paths.join(', ')}`,
                line: cut(`Files changed outside the session: ${paths.join(', ')}`, LINE_CHARS),
            }),
        });
    }

    const sorted = drafts.map((d, i) => ({ d, i })).sort((a, b) => a.d.at.getTime() - b.d.at.getTime() || a.i - b.i);
    const numbers = new Map(sorted.map(({ d }, n) => [d.key, n + 1]));
    const ref = (key: string): string | undefined => {
        const n = numbers.get(key);
        return n === undefined ? undefined : `#${n}`;
    };
    const entries = sorted.map(({ d }, n) => {
        const { full, line } = d.render(ref);
        const head = `[#${n + 1} ${time(d.at)}]`;
        return { index: n + 1, at: d.at, kind: d.kind, full: `${head} ${full}`, line: `${head} ${line}` };
    });
    return { entries, ref };
}

/** A target's name when it has no label. */
function targetName(t: Collaboration.ModelTarget): string {
    switch (t.kind) {
        case 'Workspace':
            return 'the workspace';
        case 'DtElement':
            return t.element;
        case 'DtesStorming':
            return t.storming;
        case 'DtesElement':
            return `${t.storming}.${t.local}`;
        case 'DtesOccurrence':
            return `${t.storming} ${t.timeline} ${t.eventName}`;
    }
}

function revisionName(r: Collaboration.Revision | undefined): string {
    if (!r) return 'unknown';
    switch (r.origin.kind) {
        case 'SessionStart':
            return 'as the session started';
        case 'RunBase':
            return 'before an AI turn';
        case 'RunResult':
            return 'after an AI turn';
        case 'PreRestore':
            return 'before a restore';
        case 'Manual':
            return 'a snapshot by the facilitator';
        case 'Restored':
            return 'a restored revision';
    }
}

const indent = (s: string): string =>
    s
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');

/** Targets as the agents name elements (`@{Sales.Order}`), or "none". */
const targetsText = (ts: readonly Collaboration.ModelTarget[]): string => (ts.length === 0 ? 'none' : ts.map(elementReference).join(', '));

const content = (c: Collaboration.ProposalContent): string =>
    [
        `targets: ${targetsText(c.targets)}`,
        `how: ${c.how}`,
        ...c.options.map(
            (o, i) =>
                `option ${i + 1}${o.recommended ? ' (recommended)' : ''}: ${o.label} — targets: ${targetsText(o.targets)}${o.how ? `; how: ${o.how}` : ''}`,
        ),
    ].join('\n');

/** A brief as the timeline tells it: where it goes, then its lines. */
const briefOf = (b: Collaboration.InterviewBrief): string =>
    [
        `for: ${b.name}${b.label ? ` "${b.label}"` : ''}${b.isNew ? ' (new)' : b.replaces ? ' (replacing its description)' : ''}`,
        ...briefLines(b.text).map((l) => (l.head ? `${l.head}: ${l.text}` : l.text)),
    ].join('\n');

/** A candidate of a `/` command as the timeline tells it: its label, the elements, how. */
const candidateOf = (c: Collaboration.CommandCandidate): string =>
    `- ${c.label}${c.targets.length ? ` (${c.targets.map(elementReference).join(', ')})` : ''}: ${c.how}`;

/** The label of the option an approved proposal was approved with, if it had options. */
const chosenLabel = (p: Collaboration.ChangeProposal): string | undefined =>
    p.state === 'Approved' && p.option !== undefined ? p.content.options[p.option]?.label : undefined;

/** An AI turn: its messages, outcome, summary, changes and assumptions. */
function turn(
    run: Collaboration.AgentRun,
    records: TimelineRecords,
    ref: Ref,
    messages: (ids: readonly string[], ref: Ref) => string,
): { readonly full: string; readonly line: string } {
    const ids = run.input.requests.map((r) => r.request);
    const reverting = run.input.requests.some((r) => r.reverts !== undefined);
    const reply = 'reply' in run ? run.reply : undefined;
    const changed = 'resultRevision' in run && run.resultRevision !== undefined && 'baseRevision' in run && run.resultRevision !== run.baseRevision;
    const answered = reply?.requests.some((r) => r.status === 'Answered') === true;
    const outcome = ((): string => {
        switch (run.state) {
            case 'Completed':
                return answered && !run.changed ? 'answered without editing' : run.changed ? 'completed, files changed' : 'completed, nothing changed';
            case 'NeedsClarification':
                return 'asks the facilitator first';
            case 'Declined':
                return 'declined';
            case 'Failed':
                return `failed (${run.reason})`;
            case 'Cancelled':
                return run.baseRevision === undefined ? 'cancelled before it started' : 'cancelled while running';
            case 'Reverted':
                return run.changed ? 'reverted by the server' : 'nothing was left to revert';
            default:
                return run.state;
        }
    })();
    const what = reverting ? 'AI revert' : 'AI turn';
    const head = `${what} on ${messages(ids, ref)}: ${outcome}`;
    const lines: string[] = [head];
    if (reply?.title) lines.push(`title: ${reply.title}`);
    if (reply) lines.push(`summary: ${oneLine(reply.summary)}`);
    if (reply?.answer) lines.push(`answer:\n${indent(cut(reply.answer, BODY_CHARS))}`);
    const proposals = run.input.proposals?.approved ?? [];
    for (const p of proposals)
        lines.push(
            `following the approved proposal ${ref(`proposal:${p.proposal}`) ?? ''}: ${p.instruction.label ? `${p.instruction.label} — ` : ''}${oneLine(p.instruction.how)}`.replace(
                '  ',
                ' ',
            ),
        );
    if (changed) lines.push(`changed: ${changes(run, records).join(', ') || 'files'}`);
    if (run.state === 'NeedsClarification') for (const q of reply?.questions ?? []) lines.push(`question: ${oneLine(q.text)}`);
    if (run.state === 'NeedsClarification' && !reply) lines.push(`question: ${oneLine(run.question)}`);
    for (const [i, a] of (reply?.assumptions ?? []).entries()) lines.push(`assumption: ${oneLine(a.text)} — ${assumptionDecision(run, i, records, ref)}`);
    const status = revertStatus(run, records.runs);
    if (status.kind === 'reverted') lines.push(`its changes were reverted (${ref(`run:${status.by.id}`) ?? 'by a later revert'})`);
    const [first = head, ...rest] = lines;
    return {
        full: [first, ...rest.map((l) => indent(l))].join('\n'),
        line: cut(`${head}${reply ? ` — ${oneLine(reply.title ?? reply.summary)}` : ''}`, LINE_CHARS),
    };
}

/** What a run changed: the elements when measured, else the files its revisions differ by. */
function changes(run: Collaboration.AgentRun, records: TimelineRecords): string[] {
    const elements = records.elementChanges?.get(run.id);
    if (elements && elements.length) return [...elements];
    if (!('baseRevision' in run) || !('resultRevision' in run) || !run.baseRevision || !run.resultRevision) return [];
    const base = records.revisions.find((r) => r.id === run.baseRevision);
    const result = records.revisions.find((r) => r.id === run.resultRevision);
    if (!base || !result) return [];
    return compareFiles(base.files, result.files)
        .filter((f) => f.status !== 'unchanged')
        .map((f) => `${f.path} (${f.status})`);
}

/** How an assumption of a completed run was decided: approved, an alternative picked, reverted, taken over, or open. */
function assumptionDecision(run: Collaboration.AgentRun, index: number, records: TimelineRecords, ref: Ref): string {
    if (approvalOf(records.approvals, run.id, index)) return 'approved by the facilitator';
    const picked = records.runs.find((r) => r.input.pick?.pickOf === run.id && r.input.pick.assumption === index);
    if (picked?.input.pick) return `the facilitator picked "${picked.input.pick.alternative.label}" instead (${ref(`run:${picked.id}`) ?? 'queued'})`;
    if (revertStatus(run, records.runs).kind === 'reverted') return 'closed: the turn was reverted';
    const later = laterRunOf(run, records.runs);
    if (later) return `closed: ${ref(`run:${later.id}`) ?? 'a later turn'} took the messages over`;
    return run.state === 'Completed' ? 'not decided yet' : 'not decided';
}

/** What is open now: the AI's questions awaiting an answer, proposals awaiting approval, messages waiting for the AI, the queue. */
export function openNow(records: TimelineRecords): string[] {
    const numbers = numbered(records).ref;
    const ref = (key: string): string => numbers(key) ?? 'a message';
    const open: string[] = [];
    for (const run of records.runs) {
        if (run.state !== 'NeedsClarification' || laterRunOf(run, records.runs)) continue;
        const qs = run.reply?.questions.map((q) => oneLine(q.text)) ?? [oneLine(run.question)];
        open.push(`The AI turn ${ref(`run:${run.id}`)} awaits the facilitator's answer: ${qs.join(' / ')}`);
    }
    for (const p of records.proposals) {
        if (p.state === 'Open') open.push(`The proposal ${ref(`proposal:${p.id}`)} for ${ref(`request:${p.request}`)} awaits the facilitator's approval`);
    }
    for (const i of records.interviews ?? []) {
        if (i.state === 'Asking')
            open.push(
                `The interview /${commandId(i.command)} ${ref(`interview:${i.id}`)} runs: ${i.awaiting ? 'the AI is to ask its next question' : 'the AI asked, the answer is awaited'}`,
            );
        if (i.state === 'Briefed') open.push(`The brief of the interview /${commandId(i.command)} ${ref(`interview:${i.id}`)} awaits confirmation`);
    }
    for (const c of records.slashCommands ?? []) {
        const what = `/${slashCommandName(c.kind)} ${ref(`command:${c.id}`)}`;
        if (c.state === 'Working') open.push(`The command ${what} runs: the AI is working on it`);
        if (c.state === 'Listed' && c.candidates.length) open.push(`The candidates of the command ${what} await a choice`);
    }
    for (const t of records.triages) {
        if (t.state === 'Pending') open.push(`${ref(`request:${t.request}`)} waits for the AI (being triaged)`);
        else if (t.kind === 'Consultation' && !t.outcome) open.push(`${ref(`request:${t.request}`)} waits for the AI's answer`);
        else if (t.kind === 'ChangeRequest' && !t.outcome) open.push(`${ref(`request:${t.request}`)} waits for a proposal or a run`);
    }
    const running = records.runs.find((r) => r.state === 'Running');
    const queued = records.runs.filter((r) => r.state === 'Queued');
    const of = (r: Collaboration.AgentRun): string => r.input.requests.map((q) => ref(`request:${q.request}`)).join(', ');
    if (running) open.push(`Running now: the AI turn on ${of(running)}`);
    if (queued.length) open.push(`Queued: ${queued.map((r) => `the AI turn on ${of(r)}`).join('; ')}`);
    return open;
}

/**
 * The session so far as an agent gets it: the newest `full` entries in full, the `lines` before them one line each, the
 * older ones counted; then what is open now. With `since` (the `last` of a previous call, for a warm agent that was
 * given the timeline up to that entry), only the entries after it, within the same limits.
 */
export function sessionSoFar(
    records: TimelineRecords,
    options: { readonly since?: number; readonly full?: number; readonly lines?: number } = {},
): SessionSoFar {
    const full = options.full ?? TIMELINE_LIMITS.full;
    const lineCount = options.lines ?? TIMELINE_LIMITS.lines;
    const all = numbered(records).entries;
    const last = all.at(-1)?.index ?? 0;
    const fresh = options.since === undefined ? all : all.filter((e) => e.index > (options.since ?? 0));
    const inFull = fresh.slice(-full);
    const asLines = fresh.slice(0, Math.max(0, fresh.length - full)).slice(-lineCount);
    const omitted = fresh.length - inFull.length - asLines.length;
    const open = openNow(records);
    const parts: string[] = [];
    if (options.since !== undefined) parts.push(`Since entry #${options.since}:`);
    if (omitted > 0) parts.push(`(${omitted} earlier ${omitted === 1 ? 'entry' : 'entries'} not shown)`);
    if (asLines.length) parts.push(asLines.map((e) => e.line).join('\n'));
    if (inFull.length) parts.push(inFull.map((e) => e.full).join('\n'));
    if (!fresh.length) parts.push(options.since === undefined ? '(nothing yet)' : '(nothing new)');
    parts.push(open.length ? `Open now:\n${open.map((o) => `- ${o}`).join('\n')}` : 'Open now: nothing.');
    return { text: parts.join('\n\n'), entries: [...asLines, ...inFull], omitted, last, open };
}

/**
 * The chat around an addressed message for the triage's light model: the messages (people's and the AI's answers) up to
 * and including it, newest last, at most `max` of them and `chars` characters in all, one line each.
 */
export function chatWindow(
    records: Pick<TimelineRecords, 'session' | 'requests'>,
    request: string,
    limits: { readonly max: number; readonly chars: number } = { max: 20, chars: 4000 },
): string[] {
    const names = new Map<string, string>(records.session.participants.map((p) => [p.id, p.name]));
    const at = records.requests.findIndex((r) => r.id === request);
    if (at < 0) return [];
    const lines: string[] = [];
    let used = 0;
    for (const r of records.requests.slice(0, at + 1).reverse()) {
        if (lines.length >= limits.max) break;
        const who = isAi(r.author) ? AI_NAME : (names.get(r.author) ?? 'a participant');
        const line = `${who}: ${cut(oneLine(plainBody(r.body)), LINE_CHARS)}`;
        if (used + line.length > limits.chars && lines.length > 0) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.reverse();
}
