// What the guide's card shows, without React (the plan's "ガイド (`/guide`)"): the guide commands of the session and
// which is the latest; the snapshot's map as the latest card shows it, the person's ✓ marks as they are now laid over
// it (a card in history keeps its map as it was; the marks are the journey file's, `journey-view.ts`); a finding's
// view as the page opens it; and the message 「聞くことをメモ」 sends.
import type { GuideMarkKey } from '@domaintrail/collaboration';
import type { SendRequestBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { mentionName } from './mentions';
import type { SlashCommandJson } from './slash';
import type { ModelTarget } from './targets';
import type { ViewTarget } from './views';

/** A guide command as the page reads it. */
export type GuideCommandJson = SlashCommandJson;

/** The snapshot a guide kept when it started (none: one stored before it kept one). */
export type GuideSnapshotJson = NonNullable<SlashCommandJson['guide']>;
export type GuideMapJson = GuideSnapshotJson['maps'][number];
export type GuideFindingJson = GuideSnapshotJson['findings'][number];
export type GuideStepJson = GuideMapJson['steps'][number];
export type GuideRowJson = GuideMapJson['contexts'][number];

/** The guide's answer (its status and steps) as the page reads it. */
export type GuideAdviceJson = NonNullable<Extract<SlashCommandJson, { state: 'Answered' }>['next']>;

/** Whether a command is a guide. */
export const isGuide = (c: Pick<SlashCommandJson, 'kind'>): boolean => c.kind === 'Guide';

/** The latest guide of the session (by when it started), if any. */
export function latestGuide(state: Pick<SessionStateBody, 'slashCommands'>): SlashCommandJson | undefined {
    return (state.slashCommands ?? []).filter(isGuide).reduce<SlashCommandJson | undefined>((a, c) => (!a || c.startedAt >= a.startedAt ? c : a), undefined);
}

/** The AI's messages that answered a guide: its card shows them, so the stream does not. */
export function guideAnswers(state: Pick<SessionStateBody, 'slashCommands'>): ReadonlySet<string> {
    return new Set((state.slashCommands ?? []).flatMap((c) => (isGuide(c) && c.state === 'Answered' ? [c.answer] : [])));
}

/** The steps placed again: the first not done up to the goal is here. */
function replaced(steps: readonly GuideStepJson[]): GuideStepJson[] {
    const here = steps.findIndex((s) => s.state !== 'Done' && !s.after);
    return steps.map((s, i): GuideStepJson => ({ ...s, state: s.state === 'Done' ? 'Done' : i === here ? 'Here' : 'Todo' }));
}

/**
 * A map with the person's marks as they are now (the latest card): a markable step is done by the files (as the
 * snapshot told, unless only its mark made it so) or by a mark now; a BC row likewise; here placed again.
 */
export function withMarks(map: GuideMapJson, marks: readonly GuideMarkKey[]): GuideMapJson {
    const journey = map.journey;
    if (journey === undefined) return map;
    const has = (step: string, context?: string): boolean => marks.some((m) => m.journey === journey && m.step === step && m.context === context);
    const steps = map.steps.map((s): GuideStepJson => {
        if (!s.markable) return s;
        const marked = has(s.key);
        const byFiles = s.state === 'Done' && !s.marked;
        return { ...s, marked, state: byFiles || marked ? 'Done' : 'Todo' };
    });
    const at = map.contextsAt;
    const contexts = map.contexts.map((r): GuideRowJson => {
        if (at === undefined) return r;
        const marked = has(at, r.context);
        const byFiles = r.state === 'Done' && !r.marked;
        return { ...r, marked, state: byFiles || marked ? 'Done' : r.state === 'Here' ? 'Here' : 'Todo' };
    });
    const [first, ...rest] = replaced(steps);
    return { ...map, steps: first ? [first, ...rest] : map.steps, contexts };
}

const VIEW_LEVELS = { BigPicture: 'big-picture', DesignLevel: 'design-level' } as const;
const STRUCTURE_LEVELS = { Detail: 'detail', Overview: 'overview', Aggregates: 'aggregates' } as const;

/** A finding's view as the page opens it: a storming's stage or timeline, a context's structure, the map, the catalog. */
export function viewTargetOfShown(view: NonNullable<GuideFindingJson['view']>): ViewTarget {
    switch (view.kind) {
        case 'Storming': {
            const timelineId = view.stage !== undefined ? `@${view.stage}` : view.timeline;
            return { kind: 'storming', stormingId: view.storming, level: VIEW_LEVELS[view.level], ...(timelineId !== undefined && { timelineId }) };
        }
        case 'Structure':
            return {
                kind: 'structure',
                level: STRUCTURE_LEVELS[view.level],
                ...(view.focus.length > 0 && { focus: { contexts: view.focus, hidden: [] } }),
            };
        case 'ContextMap':
            return { kind: 'contextMap', all: view.all };
        case 'Catalog':
            return { kind: 'catalog' };
    }
}

/**
 * 「聞くことをメモ」: a message to the AI (mentioned, so that Collab addresses it) asking it to add the question as a
 * hotspot, at the step's first place when it has one (a chip and its `#` mention). The triage makes it a request: the
 * facilitator's runs, a participant's becomes a proposal the facilitator approves.
 */
export function askBody(input: {
    readonly ask: string;
    readonly at?: { readonly target: ModelTarget; readonly name: string };
    readonly revision: string;
    readonly texts: { readonly askText: (ask: string) => string; readonly askAt: (target: string, ask: string) => string };
    readonly aiName: string;
}): SendRequestBody {
    const { ask, at, revision, texts } = input;
    const text = at ? texts.askAt(`#${mentionName(at.name)}[1]`, ask) : texts.askText(ask);
    return {
        targets: at ? [{ target: at.target, label: at.name, sourceRevision: revision }] : [],
        body: `@${mentionName(input.aiName)}[p1] ${text}`,
        mentions: ['ai'],
    };
}
