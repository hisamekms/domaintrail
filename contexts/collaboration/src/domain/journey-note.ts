// dt's note after an interview's brief is confirmed (`/es:start`, `/model:start`): two short lines, posted under the
// AI's name as the last reply in the interview's thread, with no AI call. Line 1 says what was decided (the journey
// added, the storming created, the brief revised, a participant's brief approved); line 2 says where the journey is
// (its map's 📍 step, by the same rule as the chip) and the next step. The next step's command (into the composer) or
// the place it shows (the source storming) is kept on the message (`JourneyNote`) for the page's buttons, beside
// 「🧭 旅程を開く」. The brief itself is not repeated: the journeys panel shows it.
//
// One place for the template and the next-step table, in Japanese and English (the interview's language). Pure.
import { Collaboration } from '../generated/index.js';
import { guideJourneyMap, guideMarks, journeyMarks, readGuideGoal, stormingFacts, type GuideWorkspace, type StormingFacts } from './guide.js';
import type { EsGoalLevel } from './guide-paths.js';
import { journeySummaries, type JourneyFile, type JourneySummary } from './journey.js';

type Lang = Collaboration.UiLanguage;

/** The fields of a brief whose change a revision names, in the order they are listed. */
export const BRIEF_FIELDS = ['name', 'purpose', 'scope', 'constraints', 'participants', 'use', 'level', 'pattern', 'goal', 'source'] as const;
export type BriefFieldKey = (typeof BRIEF_FIELDS)[number];

/** What line 1 says was decided. */
export type JourneyDecided =
    /** An existing storming's ES journey added (its brief confirmed). */
    | { readonly kind: 'esAdded'; readonly label: string; readonly level: EsGoalLevel }
    /** A new storming created by its run, and its ES journey added. */
    | { readonly kind: 'esCreated'; readonly label: string; readonly level: EsGoalLevel }
    /** The run that was to create a new storming did not complete: the journey stays as written. */
    | { readonly kind: 'esNotCreated'; readonly label: string }
    /** A modeling journey added. */
    | { readonly kind: 'modelAdded'; readonly name: string; readonly pattern: Collaboration.GuidePattern; readonly goal: string }
    /** An existing journey's brief revised: the fields that changed (none: nothing did). */
    | { readonly kind: 'revised'; readonly changed: readonly BriefFieldKey[] };

/** What the note is written from. */
export interface JourneyNoteInput {
    /** The journey's key (`es:<storming>`, or a modeling journey's ID). */
    readonly journey: string;
    readonly decided: JourneyDecided;
    /** The interview's language. */
    readonly language: Lang;
    /** The facilitator who approved a participant's brief (their name); absent when its starter confirmed it. */
    readonly approvedBy?: string;
    /** The workspace with the journey file as written (absent: not known, as after a new storming's run). */
    readonly workspace?: GuideWorkspace;
}

/** The note: its text (two lines) and the buttons' data. */
export interface JourneyNoteText {
    readonly body: string;
    readonly note: Collaboration.JourneyNote;
}

// ---- The words ----

interface Words {
    readonly steps: Readonly<Record<string, string>>;
    readonly levels: Readonly<Record<EsGoalLevel, string>>;
    readonly patterns: Readonly<Record<Collaboration.GuidePattern, string>>;
    readonly fields: Readonly<Record<BriefFieldKey, string>>;
    readonly list: string;
    readonly goal: (goal: string) => string;
    readonly how: (pattern: string, goal: string) => string;
    readonly esAdded: (label: string, how: string) => string;
    readonly esCreated: (label: string, how: string) => string;
    readonly esNotCreated: (label: string) => string;
    readonly modelAdded: (name: string, how: string) => string;
    readonly revised: (changed: string | undefined) => string;
    readonly approvedAdded: (by: string, how: string) => string;
    readonly approvedCreated: (by: string, label: string, how: string) => string;
    readonly approvedRevised: (by: string, changed: string | undefined) => string;
    readonly here: (step: string) => string;
    readonly next: NextWords;
}

/** The next step of each place, as a sentence. */
interface NextWords {
    readonly firstEvents: string;
    readonly brief: string;
    readonly moreEvents: string;
    readonly flows: string;
    readonly exceptionsOf: (stage: string) => string;
    readonly exceptions: string;
    readonly openQuestions: (n: number) => string;
    readonly questions: string;
    readonly designLevel: string;
    readonly terms: string;
    readonly subdomains: string;
    readonly bcSplit: string;
    readonly contextMap: string;
    readonly contextsOf: (context: string) => string;
    readonly contexts: string;
    readonly invariants: string;
    readonly review: string;
    readonly bcCarved: string;
    readonly aggregates: string;
    readonly commands: string;
    readonly values: string;
    readonly policies: string;
    readonly diagnostics: string;
    readonly termsAligned: string;
    readonly boundaries: string;
    readonly reachedToModeling: string;
    readonly reachedRecap: string;
    readonly reached: string;
}

const JA: Words = {
    steps: {
        brief: 'ブリーフ',
        events: '出来事',
        flows: '流れ・段階',
        exceptions: '例外',
        questions: '問い',
        designLevel: 'デザインレベル',
        terms: '用語',
        subdomains: 'サブドメイン',
        bcSplit: 'BC を分ける',
        contextMap: 'コンテキストマップ',
        contexts: '各 BC を深掘り',
        invariants: '不変条件',
        review: 'ES を見直す',
        bcCarved: 'BC を切り出す',
        aggregates: '集約',
        commands: 'コマンド',
        values: '値と ID',
        policies: 'ポリシー',
        diagnostics: '診断',
        termsAligned: '用語を揃える',
        boundaries: '境界を見直す',
    },
    levels: { BigPicture: 'ビッグピクチャー', DesignLevel: 'デザインレベル' },
    patterns: { Whole: '全体から', FromStorming: 'ES から', OneContext: '1つの BC を深掘り', Review: '既存モデルの見直し' },
    fields: {
        name: '名前',
        purpose: '目的',
        scope: '範囲',
        constraints: '制約',
        participants: '参加者',
        use: '使い道',
        level: 'レベル',
        pattern: '進め方',
        goal: 'ゴール',
        source: 'もと',
    },
    list: '・',
    goal: (goal) => `ゴール：${goal}`,
    how: (pattern, goal) => `${pattern} → ${goal}`,
    esAdded: (label, how) => `ブリーフを確定しました。旅程に「${label}」を加えました（${how}）。`,
    esCreated: (label, how) => `ストーミング「${label}」を作り、旅程に加えました（${how}）。`,
    esNotCreated: (label) => `ストーミング「${label}」を作れませんでした。旅程はそのまま残しています。`,
    modelAdded: (name, how) => `旅程に「${name}」を加えました（${how}）。`,
    revised: (changed) =>
        changed === undefined ? 'ブリーフを見直しました（変わったところはありません）。' : `ブリーフを見直しました（${changed}が変わりました）。`,
    approvedAdded: (by, how) => `${by}が承認し、旅程に加えました（${how}）。`,
    approvedCreated: (by, label, how) => `${by}が承認し、ストーミング「${label}」を作って旅程に加えました（${how}）。`,
    approvedRevised: (by, changed) =>
        changed === undefined
            ? `${by}が承認し、ブリーフを見直しました（変わったところはありません）。`
            : `${by}が承認し、ブリーフを見直しました（${changed}が変わりました）。`,
    here: (step) => `いまは「${step}」の段階です。`,
    next: {
        firstEvents: 'まず出来事を出します。起きたことを話してください。',
        brief: '次はブリーフを決めましょう。',
        moreEvents: '起きたことをもっと話してください。',
        flows: '次は出来事を流れに並べましょう。',
        exceptionsOf: (stage) => `次は「${stage}」の例外を出しましょう。`,
        exceptions: '次は例外を出しましょう。',
        openQuestions: (n) => `次は残っている問い（${n} 件）に答えを出しましょう。`,
        questions: '次は気になることを問いとして出しましょう。',
        designLevel: '次はコマンドと集約を置きましょう。',
        terms: '次は用語を出しましょう。',
        subdomains: '次はサブドメインを分けましょう。',
        bcSplit: '次は BC を分けましょう。',
        contextMap: '次はコンテキストマップを描きましょう。',
        contextsOf: (context) => `次は「${context}」を深掘りしましょう。`,
        contexts: '次は各 BC を深掘りしましょう。',
        invariants: '次は不変条件を足しましょう。',
        review: '次はもとのストーミングを見直しましょう。',
        bcCarved: '次はストーミングから BC を切り出しましょう。',
        aggregates: '次は集約を置きましょう。',
        commands: '次はコマンドとイベントを足しましょう。',
        values: '次は値と ID を決めましょう。',
        policies: '次はポリシーを足しましょう。',
        diagnostics: '次はエラーと警告を片付けましょう。',
        termsAligned: '次は用語を揃えましょう。',
        boundaries: '次は境界を見直しましょう。',
        reachedToModeling: 'ゴールに着いています。次はモデリングを始めましょう。',
        reachedRecap: 'ゴールに着いています。ここまでをまとめましょう。',
        reached: 'ゴールに着いています。',
    },
};

const EN: Words = {
    steps: {
        brief: 'Brief',
        events: 'Events',
        flows: 'Flows, stages',
        exceptions: 'Exceptions',
        questions: 'Questions',
        designLevel: 'Design Level',
        terms: 'Terms',
        subdomains: 'Subdomains',
        bcSplit: 'Split the BCs',
        contextMap: 'Context map',
        contexts: 'Each BC in depth',
        invariants: 'Invariants',
        review: 'Review the storming',
        bcCarved: 'Carve the BCs',
        aggregates: 'Aggregates',
        commands: 'Commands',
        values: 'Values and IDs',
        policies: 'Policies',
        diagnostics: 'Diagnostics',
        termsAligned: 'Align the terms',
        boundaries: 'Review the boundaries',
    },
    levels: { BigPicture: 'Big Picture', DesignLevel: 'Design Level' },
    patterns: { Whole: 'From the whole', FromStorming: 'From a storming', OneContext: 'One BC in depth', Review: 'Review the model' },
    fields: {
        name: 'name',
        purpose: 'purpose',
        scope: 'scope',
        constraints: 'constraints',
        participants: 'people',
        use: 'use',
        level: 'level',
        pattern: 'pattern',
        goal: 'goal',
        source: 'source',
    },
    list: ', ',
    goal: (goal) => `goal: ${goal}`,
    how: (pattern, goal) => `${pattern} → ${goal}`,
    esAdded: (label, how) => `Brief confirmed. Added “${label}” to the journeys (${how}).`,
    esCreated: (label, how) => `Created the storming “${label}” and added it to the journeys (${how}).`,
    esNotCreated: (label) => `Could not create the storming “${label}”. Its journey is kept as written.`,
    modelAdded: (name, how) => `Added “${name}” to the journeys (${how}).`,
    revised: (changed) => (changed === undefined ? 'Brief revised (nothing changed).' : `Brief revised (changed: ${changed}).`),
    approvedAdded: (by, how) => `${by} approved it and added it to the journeys (${how}).`,
    approvedCreated: (by, label, how) => `${by} approved it, created the storming “${label}” and added it to the journeys (${how}).`,
    approvedRevised: (by, changed) =>
        changed === undefined ? `${by} approved the revised brief (nothing changed).` : `${by} approved the revised brief (changed: ${changed}).`,
    here: (step) => `You are at “${step}”. `,
    next: {
        firstEvents: 'First, the events: tell what happens.',
        brief: 'Next, set the brief.',
        moreEvents: 'Tell what else happens.',
        flows: 'Next, put the events in a flow.',
        exceptionsOf: (stage) => `Next, the exceptions of “${stage}”.`,
        exceptions: 'Next, the exceptions.',
        openQuestions: (n) => `Next, answer the open question${n === 1 ? '' : 's'} (${n}).`,
        questions: 'Next, raise what is unclear as questions.',
        designLevel: 'Next, place the commands and aggregates.',
        terms: 'Next, list the terms.',
        subdomains: 'Next, classify the subdomains.',
        bcSplit: 'Next, split the BCs.',
        contextMap: 'Next, draw the context map.',
        contextsOf: (context) => `Next, go into “${context}” in depth.`,
        contexts: 'Next, go into each BC in depth.',
        invariants: 'Next, add the invariants.',
        review: 'Next, review the source storming.',
        bcCarved: 'Next, carve the BCs from the storming.',
        aggregates: 'Next, place the aggregates.',
        commands: 'Next, add the commands and events.',
        values: 'Next, settle the values and IDs.',
        policies: 'Next, add the policies.',
        diagnostics: 'Next, clear the errors and warnings.',
        termsAligned: 'Next, align the terms.',
        boundaries: 'Next, review the boundaries.',
        reachedToModeling: 'The goal is reached. Next, start modeling.',
        reachedRecap: 'The goal is reached. Recap what you have.',
        reached: 'The goal is reached.',
    },
};

const wordsOf = (language: Lang): Words => (language === 'En' ? EN : JA);

// ---- Line 1: what was decided ----

/** A modeling goal's or an ES level's name. */
const goalName = (w: Words, goal: string): string => w.steps[goal] ?? goal;

function decidedLine(w: Words, decided: JourneyDecided, approvedBy: string | undefined): string {
    const changed = (keys: readonly BriefFieldKey[]): string | undefined => (keys.length === 0 ? undefined : keys.map((k) => w.fields[k]).join(w.list));
    switch (decided.kind) {
        case 'esAdded': {
            const how = w.goal(w.levels[decided.level]);
            return approvedBy === undefined ? w.esAdded(decided.label, how) : w.approvedAdded(approvedBy, how);
        }
        case 'esCreated': {
            const how = w.goal(w.levels[decided.level]);
            return approvedBy === undefined ? w.esCreated(decided.label, how) : w.approvedCreated(approvedBy, decided.label, how);
        }
        case 'esNotCreated':
            return w.esNotCreated(decided.label);
        case 'modelAdded': {
            const how = w.how(w.patterns[decided.pattern], goalName(w, decided.goal));
            return approvedBy === undefined ? w.modelAdded(decided.name, how) : w.approvedAdded(approvedBy, how);
        }
        case 'revised':
            return approvedBy === undefined ? w.revised(changed(decided.changed)) : w.approvedRevised(approvedBy, changed(decided.changed));
    }
}

/**
 * The fields of a journey's brief that differ between two versions (the revision's line): the why, how far (the ES
 * level and use; the modeling pattern and goal) and the source; for ES the goal is the level, so only the level is named.
 */
export function changedBriefFields(before: JourneySummary, after: JourneySummary): BriefFieldKey[] {
    const same = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => (a ?? []).join('\n') === (b ?? []).join('\n');
    const differs: Record<BriefFieldKey, boolean> = {
        name: before.kind === 'model' && before.name !== after.name,
        purpose: before.purpose !== after.purpose,
        scope: before.scope !== after.scope,
        constraints: before.constraints !== after.constraints,
        participants: !same(before.participants, after.participants),
        use: before.use !== after.use,
        level: before.level !== after.level,
        pattern: before.pattern !== after.pattern,
        goal: before.kind === 'model' && before.goal !== after.goal,
        source: before.kind === 'model' && (!same(before.stormings, after.stormings) || before.context !== after.context),
    };
    return BRIEF_FIELDS.filter((k) => differs[k]);
}

/** A journey of a file as the page lists it, by its key. */
export const journeySummaryOf = (file: JourneyFile | undefined, key: string): JourneySummary | undefined =>
    file && journeySummaries(file).find((j) => j.key === key);

// ---- Line 2: where the journey is, and the next step ----

/** The next step: its sentence (with where the journey is, when it is somewhere), and its button's data. */
export interface JourneyNext {
    readonly text: string;
    readonly command?: Collaboration.SuggestedCommand;
    readonly targets: readonly Collaboration.ModelTarget[];
}

const stormingTarget = (id: string): Collaboration.ModelTarget[] => {
    const name = Collaboration.makeStormingName(id);
    return name.ok ? [{ kind: 'DtesStorming', storming: name.value }] : [];
};

/** The ES journey's storming, as the files tell it (none: not there yet). */
function esFacts(workspace: GuideWorkspace | undefined, key: string): StormingFacts | undefined {
    const found = workspace?.stormings.find((s) => `es:${s.id}` === key);
    return found && stormingFacts(found, true);
}

/**
 * Where a journey is and its next step, from the guide's map of it (its 📍 step, the chip's rule): a sentence per step,
 * the command that fits it (`/es:exceptions` for the exceptions, `/es:levels` for the Design Level, `/model:start` or
 * `/es:recap` at an ES goal), or the source storming to show (a modeling journey from a storming). A storming not
 * written yet, or without events: 「まず出来事を出します。」 with no button.
 */
export function journeyNext(input: { readonly journey: string; readonly language: Lang; readonly workspace?: GuideWorkspace }): JourneyNext {
    const w = wordsOf(input.language);
    const n = w.next;
    const { workspace, journey } = input;
    const es = journey.startsWith('es:');
    const facts = es ? esFacts(workspace, journey) : undefined;
    if (es && (!facts || facts.events === 0)) return { text: n.firstEvents, targets: [] };
    const goal = workspace && readGuideGoal(workspace);
    const map = workspace && goal && guideJourneyMap(workspace, goal, journey, guideMarks(journeyMarks(workspace.journey)));
    if (!map) return { text: es ? n.firstEvents : n.reached, targets: [] };
    const here = map.steps.find((s) => s.state === 'Here');
    if (!here) {
        if (!es) return { text: n.reached, targets: [] };
        const use = workspace.journey?.stormings[journey.slice(3)]?.use;
        return use === 'modeling'
            ? { text: n.reachedToModeling, command: 'ModelStart', targets: [] }
            : { text: n.reachedRecap, command: 'EsRecap', targets: [] };
    }
    const step: string = here.key;
    const at = w.here(w.steps[step] ?? step);
    const say = (text: string, more: Omit<JourneyNext, 'text'> = { targets: [] }): JourneyNext => ({ text: `${at}${text}`, ...more });
    const source = (): Collaboration.ModelTarget[] => {
        const entry = workspace.journey?.modeling.find((m) => m.id === journey);
        const from = entry?.from && 'stormings' in entry.from ? entry.from.stormings : [];
        return from.slice(0, 3).flatMap(stormingTarget);
    };
    switch (step) {
        case 'brief':
            return say(n.brief, { command: 'EsStart', targets: [] });
        case 'events':
            return say(n.moreEvents);
        case 'flows':
            return say(n.flows);
        case 'exceptions': {
            const stage = facts?.stages.find((s) => s.exceptions === 0);
            return say(stage ? n.exceptionsOf(stage.label ?? stage.id) : n.exceptions, { command: 'EsExceptions', targets: [] });
        }
        case 'questions': {
            const open = facts?.openHotspots.length ?? 0;
            return say(open > 0 ? n.openQuestions(open) : n.questions);
        }
        case 'designLevel':
            return say(n.designLevel, { command: 'EsLevels', targets: [] });
        case 'contexts': {
            // the BC row here, by name
            const row = map.contexts.find((r) => r.state === 'Here');
            return say(row ? n.contextsOf(row.context) : n.contexts);
        }
        case 'bcCarved':
            return say(n.bcCarved, { targets: source() });
        case 'aggregates':
            return say(n.aggregates);
        case 'boundaries':
            return say(n.boundaries);
        case 'review':
            return say(n.review, { targets: source() });
        case 'terms':
            return say(n.terms);
        case 'subdomains':
            return say(n.subdomains);
        case 'bcSplit':
            return say(n.bcSplit);
        case 'contextMap':
            return say(n.contextMap);
        case 'invariants':
            return say(n.invariants);
        case 'commands':
            return say(n.commands);
        case 'values':
            return say(n.values);
        case 'policies':
            return say(n.policies);
        case 'diagnostics':
            return say(n.diagnostics);
        case 'termsAligned':
            return say(n.termsAligned);
        default:
            return say(n.reached);
    }
}

// ---- The note ----

/** The note after a brief is confirmed: line 1 (what was decided), line 2 (where the journey is, the next step), the buttons' data. */
export function journeyNote(input: JourneyNoteInput): JourneyNoteText {
    const first = decidedLine(wordsOf(input.language), input.decided, input.approvedBy);
    // a storming not created: no next step but trying again (its journey is kept); the files not known: none either,
    // but for a storming just created (it holds no events yet)
    const next: JourneyNext =
        input.decided.kind === 'esNotCreated' || (!input.workspace && input.decided.kind !== 'esCreated')
            ? { text: '', targets: [] }
            : journeyNext({ journey: input.journey, language: input.language, ...(input.workspace && { workspace: input.workspace }) });
    const key = Collaboration.makeGuideJourneyKey(input.journey);
    if (!key.ok) throw new Error(`Not a journey key: ${input.journey}`);
    return {
        body: next.text === '' ? first : `${first}\n${next.text}`,
        note: { journey: key.value, ...(next.command && { command: next.command }), targets: [...next.targets] },
    };
}

/**
 * What a confirmed brief decided, from the journey file before and after it was written: a revision when the journey
 * was there, else the journey added (a new storming's once its run created it). `label`: the storming's label, when the
 * files have it (an ES journey is named by it).
 */
export function decidedOf(input: {
    readonly brief: Collaboration.InterviewBrief;
    readonly key: string;
    readonly before: JourneyFile | undefined;
    readonly after: JourneyFile;
    readonly label?: string;
}): JourneyDecided | undefined {
    const was = journeySummaryOf(input.before, input.key);
    const now = journeySummaryOf(input.after, input.key);
    if (!now) return undefined;
    if (was) return { kind: 'revised', changed: changedBriefFields(was, now) };
    if (now.kind === 'model') return { kind: 'modelAdded', name: now.name, pattern: now.pattern ?? 'Whole', goal: now.goal };
    const label = input.label ?? input.brief.label ?? input.brief.name;
    const level = now.level ?? 'BigPicture';
    return input.brief.isNew ? { kind: 'esCreated', label, level } : { kind: 'esAdded', label, level };
}
