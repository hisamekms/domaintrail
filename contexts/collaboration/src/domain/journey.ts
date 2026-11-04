// The journey file (the plan's "The journey file" and "The journey file's format and contents"): `domaintrail.journey.json`
// at the workspace root, next to `domaintrail.jsonc`, tracked by git — what the work in the workspace is for (the
// why: purpose, scope, constraints, participants as roles), how far it goes (the ES level per storming; the modeling
// journeys' pattern, goal and subject) and how far it has come (the steps a person marked done). Not the model, not
// configuration (never trust-hashed), not session state.
//
// Here, pure: the file's shape (its schema is `schema/journey.schema.json`, its enums the guide's vocabulary in
// `guide-paths.ts`), reading it (what is valid is kept, each problem said with where it is), writing it (a stable key
// order, two-space indent: small diffs), the explicit acts that change it (a brief confirmed, a goal changed, a state
// set, a mark set or cleared), what the guide reads of it, and `dt check`'s findings on it (J001–J003). Only dt writes
// it (the AI reads it); the I/O is the application's port.
import type { Diagnostic } from '@domaintrail/kernel';
import { err, ok, type Collaboration, type Result } from '../generated/index.js';
import { ES_GOALS, ES_LEVELS, ES_MARKABLE, GUIDE_PATTERNS, MODEL_PATTERNS, PATTERN_SUBJECT, patternMarkable, type EsGoalLevel } from './guide-paths.js';
import { itemPath, lineColumn, memberPath, readJsonWithSpans, type JsonSpan } from './json-positions.js';

/** The file's name, at the workspace root (the directory of `domaintrail.jsonc`, what `dt -r` names). */
export const JOURNEY_FILE = 'domaintrail.journey.json';

/** The `$schema` a new file is written with: the schema in the installed package. */
export const JOURNEY_SCHEMA_REF = './node_modules/domaintrail/schema/journey.schema.json';

/** The format's version. */
export const JOURNEY_VERSION = 1;

/** A journey's state: in progress, done (set by a person on reaching the goal), archived (out of the guide's picker). */
export type JourneyState = 'active' | 'done' | 'archived';
export const JOURNEY_STATES: readonly JourneyState[] = ['active', 'done', 'archived'];

/** What an event storming's result is for: aligning people, or leading into modeling. */
export type JourneyUse = 'align' | 'modeling';
export const JOURNEY_USES: readonly JourneyUse[] = ['align', 'modeling'];

/** A modeling journey's ID: a short slug (lowercase letters, digits, hyphens), used for its marks and the session's current journey. */
export const JOURNEY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The limits of the file's texts (the brief's `BriefField`, `RoleName`, `JourneyName`). */
export const JOURNEY_LIMITS = { field: 240, role: 60, roles: 12, name: 100, id: 60, stormings: 10, journeys: 50 } as const;

/** An event storming's journey (one per storming, keyed by its ID). */
export interface EsJourneyEntry {
    readonly purpose: string;
    readonly scope?: string;
    readonly participants: readonly string[];
    readonly use: JourneyUse;
    readonly level: EsGoalLevel;
    readonly state: JourneyState;
    /** The steps a person marked done. */
    readonly marks: readonly string[];
}

/** What a modeling journey starts from: the stormings it carves from (B), the context it deepens (C). */
export type JourneyFrom = { readonly stormings: readonly string[] } | { readonly context: string };

/** A named modeling journey (several allowed). */
export interface ModelJourneyEntry {
    readonly id: string;
    readonly name: string;
    readonly purpose: string;
    readonly scope?: string;
    readonly constraints?: string;
    readonly participants: readonly string[];
    readonly pattern: Collaboration.GuidePattern;
    readonly from?: JourneyFrom;
    readonly goal: string;
    readonly state: JourneyState;
    /** The steps a person marked done, and the BC rows by the context's name. */
    readonly marks: { readonly steps: readonly string[]; readonly contexts: Readonly<Record<string, readonly string[]>> };
}

/** The file's contents. */
export interface JourneyFile {
    readonly $schema?: string;
    readonly version: number;
    readonly stormings: Readonly<Record<string, EsJourneyEntry>>;
    readonly modeling: readonly ModelJourneyEntry[];
}

/** No journeys (no file). */
export const EMPTY_JOURNEYS: JourneyFile = { version: JOURNEY_VERSION, stormings: {}, modeling: [] };

/** A problem of the file: where (a JSON path, `''` the whole) and what. */
export interface JourneyProblem {
    readonly path: string;
    readonly message: string;
}

/** The file read: what is valid of it (a journey with a problem is left out), its problems, where its parts are. */
export interface JourneyRead {
    readonly file: JourneyFile;
    readonly problems: readonly JourneyProblem[];
    readonly spans: ReadonlyMap<string, JsonSpan>;
    /** The offset of a syntax error (the file is then read as empty). */
    readonly syntaxAt?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the fields of one object: each problem pushed (with its path), the value if it is one. */
class Fields {
    constructor(
        readonly o: Record<string, unknown>,
        readonly path: string,
        readonly problems: JourneyProblem[],
    ) {}
    private fail(key: string, message: string): undefined {
        this.problems.push({ path: memberPath(this.path, key), message });
        return undefined;
    }
    unknown(keys: readonly string[]): boolean {
        const extra = Object.keys(this.o).filter((k) => !keys.includes(k));
        for (const k of extra) this.fail(k, 'Unknown key.');
        return extra.length === 0;
    }
    text(key: string, max: number, required: boolean): string | undefined | null {
        const v = this.o[key];
        if (v === undefined) return required ? (this.fail(key, 'Required.') ?? null) : undefined;
        if (typeof v !== 'string' || v.trim() === '') return this.fail(key, 'Expected a non-empty string.') ?? null;
        if (v.length > max || /[\n\r]/u.test(v)) return this.fail(key, `One line, at most ${max} characters.`) ?? null;
        return v;
    }
    choice<T extends string>(key: string, allowed: readonly T[]): T | null {
        const v = this.o[key];
        const found = allowed.find((a) => a === v);
        if (found !== undefined) return found;
        return this.fail(key, v === undefined ? 'Required.' : `Expected one of ${allowed.join(', ')}.`) ?? null;
    }
    strings(key: string, max: number, itemMax: number, allowed?: readonly string[]): readonly string[] | null {
        const v = this.o[key];
        if (v === undefined) return this.fail(key, 'Required.') ?? null;
        if (!Array.isArray(v)) return this.fail(key, 'Expected an array of strings.') ?? null;
        if (v.length > max) return this.fail(key, `At most ${max} items.`) ?? null;
        const at = memberPath(this.path, key);
        let bad = false;
        for (const [i, s] of v.entries()) {
            if (typeof s !== 'string' || s.trim() === '' || s.length > itemMax || /[\n\r]/u.test(s)) {
                this.problems.push({ path: itemPath(at, i), message: `Expected a non-empty one-line string of at most ${itemMax} characters.` });
                bad = true;
            } else if (allowed && !allowed.includes(s)) {
                this.problems.push({
                    path: itemPath(at, i),
                    message: allowed.length ? `Expected one of ${allowed.join(', ')}.` : 'Nothing may be marked here.',
                });
                bad = true;
            }
        }
        const items = v.filter((x): x is string => typeof x === 'string');
        if (bad || items.length !== v.length) return null;
        if (new Set(items).size !== items.length) return this.fail(key, 'An item is written twice.') ?? null;
        return items;
    }
}

function readEs(raw: unknown, path: string, problems: JourneyProblem[]): EsJourneyEntry | undefined {
    if (!isObject(raw)) {
        problems.push({ path, message: 'Expected an object.' });
        return undefined;
    }
    const before = problems.length;
    const f = new Fields(raw, path, problems);
    f.unknown(['purpose', 'scope', 'participants', 'use', 'level', 'state', 'marks']);
    const purpose = f.text('purpose', JOURNEY_LIMITS.field, true);
    const scope = f.text('scope', JOURNEY_LIMITS.field, false);
    const participants = f.strings('participants', JOURNEY_LIMITS.roles, JOURNEY_LIMITS.role);
    const use = f.choice('use', JOURNEY_USES);
    const level = f.choice('level', ES_LEVELS);
    const state = f.choice('state', JOURNEY_STATES);
    const marks = f.strings('marks', ES_MARKABLE.length, 40, ES_MARKABLE);
    if (problems.length > before || !purpose || scope === null || !participants || !use || !level || !state || !marks) return undefined;
    return { purpose, ...(scope !== undefined && { scope }), participants, use, level, state, marks };
}

function readFrom(raw: unknown, pattern: Collaboration.GuidePattern, path: string, problems: JourneyProblem[]): JourneyFrom | undefined | null {
    const subject = PATTERN_SUBJECT[pattern];
    if (raw === undefined) {
        if (!subject) return undefined;
        problems.push({
            path,
            message: subject === 'stormings' ? 'Required by FromStorming: { "stormings": [...] }.' : 'Required by OneContext: { "context": ... }.',
        });
        return null;
    }
    if (!subject) {
        problems.push({ path, message: `${pattern} takes no "from".` });
        return null;
    }
    if (!isObject(raw)) {
        problems.push({ path, message: 'Expected an object.' });
        return null;
    }
    const f = new Fields(raw, path, problems);
    if (subject === 'stormings') {
        if (!f.unknown(['stormings'])) return null;
        const stormings = f.strings('stormings', JOURNEY_LIMITS.stormings, 100);
        if (!stormings) return null;
        if (stormings.length === 0) {
            problems.push({ path: memberPath(path, 'stormings'), message: 'Name at least one storming.' });
            return null;
        }
        return { stormings };
    }
    if (!f.unknown(['context'])) return null;
    const context = f.text('context', 100, true);
    return context ? { context } : null;
}

function readModel(raw: unknown, path: string, problems: JourneyProblem[]): ModelJourneyEntry | undefined {
    if (!isObject(raw)) {
        problems.push({ path, message: 'Expected an object.' });
        return undefined;
    }
    const before = problems.length;
    const f = new Fields(raw, path, problems);
    f.unknown(['id', 'name', 'purpose', 'scope', 'constraints', 'participants', 'pattern', 'from', 'goal', 'state', 'marks']);
    const id = f.text('id', JOURNEY_LIMITS.id, true);
    if (id && !JOURNEY_ID.test(id)) problems.push({ path: memberPath(path, 'id'), message: 'Expected a slug: lowercase letters, digits and hyphens.' });
    const name = f.text('name', JOURNEY_LIMITS.name, true);
    const purpose = f.text('purpose', JOURNEY_LIMITS.field, true);
    const scope = f.text('scope', JOURNEY_LIMITS.field, false);
    const constraints = f.text('constraints', JOURNEY_LIMITS.field, false);
    const participants = f.strings('participants', JOURNEY_LIMITS.roles, JOURNEY_LIMITS.role);
    const pattern = f.choice('pattern', GUIDE_PATTERNS);
    const state = f.choice('state', JOURNEY_STATES);
    const from = pattern ? readFrom(raw.from, pattern, memberPath(path, 'from'), problems) : null;
    const goal = pattern ? f.choice('goal', MODEL_PATTERNS[pattern].goals) : null;
    let marks: ModelJourneyEntry['marks'] | undefined;
    const marksPath = memberPath(path, 'marks');
    if (!isObject(raw.marks))
        problems.push({ path: marksPath, message: raw.marks === undefined ? 'Required.' : 'Expected { "steps": [...], "contexts": {...} }.' });
    else if (pattern) {
        const m = new Fields(raw.marks, marksPath, problems);
        m.unknown(['steps', 'contexts']);
        const steps = m.strings('steps', 20, 40, patternMarkable(pattern));
        const contextsPath = memberPath(marksPath, 'contexts');
        const contexts: Record<string, readonly string[]> = {};
        if (!isObject(raw.marks.contexts)) problems.push({ path: contextsPath, message: 'Expected an object: { "<Context>": [...] }.' });
        else
            for (const ctx of Object.keys(raw.marks.contexts)) {
                const r = new Fields(raw.marks.contexts, contextsPath, problems).strings(ctx, 1, 40, [MODEL_PATTERNS[pattern].rowsAt]);
                if (r) contexts[ctx] = r;
            }
        if (steps) marks = { steps, contexts };
    }
    if (
        problems.length > before ||
        !id ||
        !name ||
        !purpose ||
        scope === null ||
        constraints === null ||
        !participants ||
        !pattern ||
        !state ||
        !goal ||
        !marks
    )
        return undefined;
    if (from === null) return undefined;
    return {
        id,
        name,
        purpose,
        ...(scope !== undefined && { scope }),
        ...(constraints !== undefined && { constraints }),
        participants,
        pattern,
        ...(from !== undefined && { from }),
        goal,
        state,
        marks,
    };
}

/**
 * Reads the file's text against its schema. What is valid is kept (a journey with a problem is left out, so that the
 * guide still reads the others); each problem is said with its path. A text that is no JSON reads as no journeys.
 */
export function readJourney(text: string): JourneyRead {
    const json = readJsonWithSpans(text);
    if (!json.ok) return { file: EMPTY_JOURNEYS, problems: [{ path: '', message: `Not JSON: ${json.message}` }], spans: new Map(), syntaxAt: json.offset };
    const problems: JourneyProblem[] = [];
    const raw = json.value;
    if (!isObject(raw)) return { file: EMPTY_JOURNEYS, problems: [{ path: '', message: 'Expected an object.' }], spans: json.spans };
    const f = new Fields(raw, '', problems);
    f.unknown(['$schema', 'version', 'stormings', 'modeling']);
    if (raw.$schema !== undefined && typeof raw.$schema !== 'string') problems.push({ path: '$schema', message: 'Expected a string.' });
    if (raw.version !== JOURNEY_VERSION) problems.push({ path: 'version', message: `Expected ${JOURNEY_VERSION}.` });
    const stormings: Record<string, EsJourneyEntry> = {};
    if (raw.stormings !== undefined && !isObject(raw.stormings)) problems.push({ path: 'stormings', message: 'Expected an object keyed by storming ID.' });
    else
        for (const [id, entry] of Object.entries(raw.stormings ?? {})) {
            const at = memberPath('stormings', id);
            if (!/^[_a-zA-Z][A-Za-z0-9_]*$/u.test(id)) {
                problems.push({ path: at, message: 'A storming ID: letters, digits and _, not starting with a digit.' });
                continue;
            }
            const es = readEs(entry, at, problems);
            if (es) stormings[id] = es;
        }
    const modeling: ModelJourneyEntry[] = [];
    if (raw.modeling !== undefined && !Array.isArray(raw.modeling)) problems.push({ path: 'modeling', message: 'Expected an array of journeys.' });
    else
        for (const [i, entry] of (raw.modeling ?? []).entries()) {
            const m = readModel(entry, itemPath('modeling', i), problems);
            if (!m) continue;
            if (modeling.some((x) => x.id === m.id)) {
                problems.push({ path: memberPath(itemPath('modeling', i), 'id'), message: `The id '${m.id}' is used by another journey.` });
                continue;
            }
            modeling.push(m);
        }
    return {
        file: { ...(typeof raw.$schema === 'string' && { $schema: raw.$schema }), version: JOURNEY_VERSION, stormings, modeling },
        problems,
        spans: json.spans,
    };
}

// ---- Writing: a stable key order, two-space indent ----

const orderedEs = (e: EsJourneyEntry): Record<string, unknown> => ({
    purpose: e.purpose,
    ...(e.scope !== undefined && { scope: e.scope }),
    participants: e.participants,
    use: e.use,
    level: e.level,
    state: e.state,
    marks: e.marks,
});

const orderedModel = (m: ModelJourneyEntry): Record<string, unknown> => ({
    id: m.id,
    name: m.name,
    purpose: m.purpose,
    ...(m.scope !== undefined && { scope: m.scope }),
    ...(m.constraints !== undefined && { constraints: m.constraints }),
    participants: m.participants,
    pattern: m.pattern,
    ...(m.from && { from: 'stormings' in m.from ? { stormings: m.from.stormings } : { context: m.from.context } }),
    goal: m.goal,
    state: m.state,
    marks: { steps: m.marks.steps, contexts: Object.fromEntries(Object.entries(m.marks.contexts).filter(([, v]) => v.length > 0)) },
});

/**
 * The file's text: `$schema`, `version`, `stormings` (in the order written: a new storming's journey comes last),
 * `modeling` (likewise); each journey's keys in the schema's order; two-space indent; a final line break.
 */
export function writeJourney(file: JourneyFile): string {
    const ordered = {
        $schema: file.$schema ?? JOURNEY_SCHEMA_REF,
        version: JOURNEY_VERSION,
        stormings: Object.fromEntries(Object.entries(file.stormings).map(([k, e]) => [k, orderedEs(e)])),
        modeling: file.modeling.map(orderedModel),
    };
    return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ---- The keys of the journeys ----

/** A journey's key (marks, the session's current journey): `es:<storming>`, or a modeling journey's ID. */
export const esJourneyKey = (storming: string): string => `es:${storming}`;

/** The journey a key names. */
export type JourneyRef =
    | { readonly kind: 'es'; readonly storming: string; readonly entry: EsJourneyEntry }
    | { readonly kind: 'model'; readonly entry: ModelJourneyEntry };

export function journeyOf(file: JourneyFile, key: string): JourneyRef | undefined {
    if (key.startsWith('es:')) {
        const storming = key.slice(3);
        const entry = Object.hasOwn(file.stormings, storming) ? file.stormings[storming] : undefined;
        return entry && { kind: 'es', storming, entry };
    }
    const entry = file.modeling.find((m) => m.id === key);
    return entry && { kind: 'model', entry };
}

/** Every journey's key, in the file's order: the stormings', then the modeling journeys'. */
export const journeyKeys = (file: JourneyFile): readonly string[] => [...Object.keys(file.stormings).map(esJourneyKey), ...file.modeling.map((m) => m.id)];

/**
 * The current journey when the session has chosen none (or one no longer there, or archived): the most recently
 * created active journey — the last active modeling journey, else the last active storming's (each kind is in the
 * order written, new ones last).
 */
export function defaultJourney(file: JourneyFile, chosen?: string): string | undefined {
    if (chosen !== undefined) {
        const j = journeyOf(file, chosen);
        if (j && j.entry.state !== 'archived') return chosen;
    }
    const model = file.modeling.filter((m) => m.state === 'active').at(-1);
    if (model) return model.id;
    const es = Object.entries(file.stormings)
        .filter(([, e]) => e.state === 'active')
        .at(-1);
    return es && esJourneyKey(es[0]);
}

/**
 * A modeling journey's ID from its name: the ASCII letters and digits of the name, lowercase, joined by hyphens (a name
 * with none: the pattern's, `journey`), cut to a few words; `-2`, `-3`… when taken.
 */
export function journeyIdFor(name: string, taken: readonly string[], fallback = 'journey'): string {
    const words = (
        name
            .normalize('NFKC')
            .toLowerCase()
            .match(/[a-z0-9]+/gu) ?? []
    ).slice(0, 5);
    const base = (words.join('-') || fallback).slice(0, JOURNEY_LIMITS.id - 4).replace(/-+$/u, '') || fallback;
    if (!taken.includes(base)) return base;
    for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

// ---- The acts that change it ----

/** Why an act could not be applied to the file. */
export type JourneyActError =
    | { readonly type: 'JourneyNotFound'; readonly journey: string }
    | { readonly type: 'NotAJourneyGoal'; readonly goal: string }
    | { readonly type: 'NotAJourneyMark'; readonly step: string }
    | { readonly type: 'NotAJourneyBrief'; readonly reason: string };

/** An explicit act on the journey file (the facilitator's own, or a participant's the facilitator approved). */
export type JourneyAct =
    | { readonly kind: 'goal'; readonly journey: string; readonly goal: string }
    | { readonly kind: 'state'; readonly journey: string; readonly state: JourneyState }
    | { readonly kind: 'mark'; readonly journey: string; readonly step: string; readonly context?: string; readonly done: boolean };

const sorted = (xs: Iterable<string>, order: readonly string[]): string[] => [...new Set(xs)].sort((a, b) => order.indexOf(a) - order.indexOf(b));

/** Applies an act: the goal changed (an ES level, or a goal the pattern allows), the state set, a mark set or cleared. */
export function applyJourneyAct(file: JourneyFile, act: JourneyAct): Result<JourneyFile, JourneyActError> {
    const j = journeyOf(file, act.journey);
    if (!j) return err({ type: 'JourneyNotFound', journey: act.journey });
    if (j.kind === 'es') {
        const e = j.entry;
        let next: EsJourneyEntry;
        switch (act.kind) {
            case 'goal': {
                const level = ES_LEVELS.find((l) => l === act.goal);
                if (!level) return err({ type: 'NotAJourneyGoal', goal: act.goal });
                next = { ...e, level };
                break;
            }
            case 'state':
                next = { ...e, state: act.state };
                break;
            case 'mark':
                if (act.context !== undefined || !(ES_MARKABLE as readonly string[]).includes(act.step))
                    return err({ type: 'NotAJourneyMark', step: act.step });
                next = { ...e, marks: sorted(act.done ? [...e.marks, act.step] : e.marks.filter((m) => m !== act.step), ES_MARKABLE) };
                break;
        }
        return ok({ ...file, stormings: { ...file.stormings, [j.storming]: next } });
    }
    const m = j.entry;
    const path = MODEL_PATTERNS[m.pattern];
    let next: ModelJourneyEntry;
    switch (act.kind) {
        case 'goal':
            if (!path.goals.includes(act.goal)) return err({ type: 'NotAJourneyGoal', goal: act.goal });
            next = { ...m, goal: act.goal };
            break;
        case 'state':
            next = { ...m, state: act.state };
            break;
        case 'mark': {
            if (act.context !== undefined) {
                if (act.step !== path.rowsAt) return err({ type: 'NotAJourneyMark', step: act.step });
                const { [act.context]: _was, ...others } = m.marks.contexts;
                next = { ...m, marks: { ...m.marks, contexts: act.done ? { ...others, [act.context]: [act.step] } : others } };
            } else {
                const markable = patternMarkable(m.pattern);
                if (!markable.includes(act.step)) return err({ type: 'NotAJourneyMark', step: act.step });
                next = {
                    ...m,
                    marks: { ...m.marks, steps: sorted(act.done ? [...m.marks.steps, act.step] : m.marks.steps.filter((s) => s !== act.step), markable) },
                };
            }
            break;
        }
    }
    return ok({ ...file, modeling: file.modeling.map((x) => (x.id === m.id ? next : x)) });
}

/** What a confirmed brief writes: the storming's ES journey (`/es:start`), or a modeling journey (`/model:start`). */
export function applyBrief(
    file: JourneyFile,
    command: Collaboration.InterviewCommand,
    brief: Collaboration.InterviewBrief,
): Result<{ readonly file: JourneyFile; readonly key: string }, JourneyActError> {
    const j = brief.journey;
    if (!j) return err({ type: 'NotAJourneyBrief', reason: 'The brief has no journey (an older brief).' });
    const why = {
        purpose: j.purpose as string,
        ...(j.scope !== undefined && { scope: j.scope as string }),
        participants: j.participants.map(String),
    };
    if (command === 'Es') {
        if (!j.use || !j.level) return err({ type: 'NotAJourneyBrief', reason: 'An event storming brief needs its use and level.' });
        const was = Object.hasOwn(file.stormings, brief.name) ? file.stormings[brief.name] : undefined;
        const entry: EsJourneyEntry = {
            ...why,
            use: j.use === 'Modeling' ? 'modeling' : 'align',
            level: j.level,
            // a revised brief keeps where the journey stands
            state: was?.state ?? 'active',
            marks: was?.marks ?? [],
        };
        return ok({ file: { ...file, stormings: { ...file.stormings, [brief.name]: entry } }, key: esJourneyKey(brief.name) });
    }
    if (!j.pattern) return err({ type: 'NotAJourneyBrief', reason: 'A modeling brief needs its pattern.' });
    const path = MODEL_PATTERNS[j.pattern];
    const goal = j.goal !== undefined && path.goals.includes(j.goal) ? (j.goal as string) : (path.goals.at(-1) ?? '');
    const subject = PATTERN_SUBJECT[j.pattern];
    let from: JourneyFrom | undefined;
    if (subject === 'stormings') {
        if (j.stormings.length === 0) return err({ type: 'NotAJourneyBrief', reason: 'FromStorming needs the storming(s) it starts from.' });
        from = { stormings: j.stormings.map(String) };
    } else if (subject === 'context') {
        if (j.context === undefined) return err({ type: 'NotAJourneyBrief', reason: 'OneContext needs its context.' });
        from = { context: j.context };
    }
    const was = file.modeling.find((m) => m.id === brief.name);
    if (j.continues && !was) return err({ type: 'JourneyNotFound', journey: brief.name });
    const name = (j.journeyName as string | undefined) ?? was?.name ?? brief.label ?? brief.name;
    // a new journey whose ID got taken since the brief: the next free one
    const id =
        was && !j.continues
            ? journeyIdFor(
                  name,
                  file.modeling.map((m) => m.id),
              )
            : brief.name;
    if (!JOURNEY_ID.test(id)) return err({ type: 'NotAJourneyBrief', reason: `Not a journey ID: ${id}` });
    const keep = was && j.continues && was.pattern === j.pattern ? was : undefined;
    const entry: ModelJourneyEntry = {
        id,
        name,
        ...why,
        ...(j.constraints !== undefined && { constraints: j.constraints as string }),
        pattern: j.pattern,
        ...(from && { from }),
        goal,
        state: was && j.continues ? was.state : 'active',
        // the marks stay while the pattern does (its steps are the same)
        marks: keep?.marks ?? { steps: [], contexts: {} },
    };
    const modeling = j.continues ? file.modeling.map((m) => (m.id === id ? entry : m)) : [...file.modeling, entry];
    return ok({ file: { ...file, modeling }, key: id });
}

// ---- What the guide and the page read ----

/** The ES goal step of a level. */
export const esGoalStep = (level: EsGoalLevel): string => ES_GOALS[level];

/** A journey as the page lists it: its key, kind, name, state, and the brief (the why) as lines. */
export interface JourneySummary {
    readonly key: string;
    readonly kind: 'es' | 'model';
    /** The storming's ID (ES), or the journey's name. */
    readonly name: string;
    readonly state: JourneyState;
    readonly pattern?: Collaboration.GuidePattern;
    readonly level?: EsGoalLevel;
    readonly use?: JourneyUse;
    readonly goal: string;
    readonly purpose: string;
    readonly scope?: string;
    readonly constraints?: string;
    readonly participants: readonly string[];
    readonly stormings?: readonly string[];
    readonly context?: string;
}

/** Every journey of the file as the page lists them, in the file's order (the stormings', then the modeling ones). */
export function journeySummaries(file: JourneyFile): readonly JourneySummary[] {
    return [
        ...Object.entries(file.stormings).map(([id, e]): JourneySummary => ({
            key: esJourneyKey(id),
            kind: 'es',
            name: id,
            state: e.state,
            level: e.level,
            use: e.use,
            goal: e.level,
            purpose: e.purpose,
            ...(e.scope !== undefined && { scope: e.scope }),
            participants: e.participants,
            stormings: [id],
        })),
        ...file.modeling.map((m): JourneySummary => ({
            key: m.id,
            kind: 'model',
            name: m.name,
            state: m.state,
            pattern: m.pattern,
            goal: m.goal,
            purpose: m.purpose,
            ...(m.scope !== undefined && { scope: m.scope }),
            ...(m.constraints !== undefined && { constraints: m.constraints }),
            participants: m.participants,
            ...(m.from && 'stormings' in m.from && { stormings: m.from.stormings }),
            ...(m.from && 'context' in m.from && { context: m.from.context }),
        })),
    ];
}

/**
 * The journeys as the answerer is given them: every journey but the archived, and the session's current one (the one
 * chosen, else the most recently created active one).
 */
export function agentJourneys(file: JourneyFile, chosen?: string): { readonly current?: string; readonly journeys: readonly JourneySummary[] } {
    const current = defaultJourney(file, chosen);
    return { ...(current !== undefined && { current }), journeys: journeySummaries(file).filter((j) => j.state !== 'archived') };
}

// ---- `dt check` ----

/** The rules on the journey file: J001 (error) the file is not valid; J002, J003 (warnings) a storming or context it names is missing. */
export type JourneyRuleId = 'J001' | 'J002' | 'J003';

/** The names of the workspace a journey may name. */
export interface JourneyNames {
    readonly stormings: ReadonlySet<string>;
    readonly contexts: ReadonlySet<string>;
}

/** The storming(s) and context a journey names that the workspace does not have. */
export function missingOf(
    summary: Pick<JourneySummary, 'kind' | 'stormings' | 'context'>,
    names: JourneyNames,
): { readonly stormings: readonly string[]; readonly context?: string } {
    const stormings = (summary.stormings ?? []).filter((s) => !names.stormings.has(s));
    const context = summary.context !== undefined && !names.contexts.has(summary.context) ? summary.context : undefined;
    return { stormings, ...(context !== undefined && { context }) };
}

/**
 * `dt check`'s findings on the file (`file`: its path as diagnostics name it): J001 for each problem against the
 * schema (at most 20), J002 for a storming a journey names that the workspace does not have (an ES journey's key, a
 * FromStorming journey's `from`), J003 for such a context (a OneContext journey's `from`). A journey with a problem is
 * not checked for names.
 */
export function journeyDiagnostics(text: string, names: JourneyNames, file = JOURNEY_FILE): Diagnostic[] {
    const read = readJourney(text);
    const at = (offset: number, end = offset + 1): Pick<Diagnostic, 'start' | 'end'> => ({
        start: lineColumn(text, offset),
        end: lineColumn(text, Math.max(end, offset + 1)),
    });
    const where = (path: string, key = false): Pick<Diagnostic, 'start' | 'end'> => {
        // the nearest part written: a missing key is reported on its object
        for (let p = path; ;) {
            const span = read.spans.get(p);
            if (span) return key && span.keyStart !== undefined ? at(span.keyStart, span.keyEnd) : at(span.start, Math.min(span.end, span.start + 80));
            if (p === '') return at(0);
            const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['));
            p = cut < 0 ? '' : p.slice(0, cut);
        }
    };
    const out: Diagnostic[] = [];
    if (read.syntaxAt !== undefined)
        out.push({ file, ...at(read.syntaxAt), severity: 'error', code: 'J001', message: read.problems[0]?.message ?? 'Not JSON.' });
    else
        for (const p of read.problems.slice(0, 20))
            out.push({
                file,
                ...where(p.path, p.message === 'Unknown key.'),
                severity: 'error',
                code: 'J001',
                message: `${p.path || 'The file'}: ${p.message}`,
                hint: 'See schema/journey.schema.json; dt writes this file, so a goal or a mark is best changed in the session.',
            });
    for (const s of journeySummaries(read.file)) {
        const missing = missingOf(s, names);
        const path =
            s.kind === 'es'
                ? memberPath('stormings', s.name)
                : itemPath(
                      'modeling',
                      read.file.modeling.findIndex((m) => m.id === s.key),
                  );
        const label = `The journey '${s.key}'`;
        for (const st of missing.stormings)
            out.push({
                file,
                ...where(s.kind === 'es' ? path : memberPath(memberPath(path, 'from'), 'stormings'), s.kind === 'es'),
                severity: 'warning',
                code: 'J002',
                message: `${label} names storming '${st}', which does not exist.`,
                hint: 'A storming renamed: rename the journey\'s key too (or its "from"); one removed: archive or remove the journey.',
            });
        if (missing.context !== undefined)
            out.push({
                file,
                ...where(memberPath(memberPath(path, 'from'), 'context')),
                severity: 'warning',
                code: 'J003',
                message: `${label} names context '${missing.context}', which does not exist.`,
                hint: 'A context renamed: rename it in the journey\'s "from" too; one removed: archive or remove the journey.',
            });
    }
    return out;
}

/** The names a journey may name, from the model's contexts and the stormings' IDs. */
export const journeyNames = (contexts: Iterable<string>, stormings: Iterable<string>): JourneyNames => ({
    contexts: new Set(contexts),
    stormings: new Set(stormings),
});
