// Where the requester was looking when they sent a message (`ViewedAt`, view.dt): the page's view as it sends it, read
// and checked at the boundary (`readViewedAt`), its names checked against the workspace when it is sent
// (`resolveViewedAt`: what is not found is dropped), and as the AI's prompts show it (`viewedAtData`), so that "here" in
// a message means something. The element selected is not part of it: it is a target (`#`).
import { Collaboration, err, ok, type Result } from '../generated/index.js';

/** The limits of a view: names as the targets' keys, at most 50 contexts and 20 catalog sections. */
export const VIEWED_AT_LIMITS = { name: 512, contexts: 50, sections: 20, query: 200 } as const;

/** Why a view could not be read: the path of the field and what is wrong. */
export interface InvalidViewedAt {
    readonly path: string;
    readonly message: string;
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (path: string, message: string): Result<never, InvalidViewedAt> => err({ path, message });

/** Only `keys` in `v`. */
function only(v: Raw, keys: readonly string[], at: string): InvalidViewedAt | undefined {
    const extra = Object.keys(v).find((k) => !keys.includes(k));
    return extra === undefined ? undefined : { path: `${at}.${extra}`, message: 'Unknown field.' };
}

/** A name on one line, without control characters, within the limit, made by a generated factory. */
function name<T>(v: unknown, at: string, make: (s: string) => Result<T, unknown>): Result<T, InvalidViewedAt> {
    // oxlint-disable-next-line eslint/no-control-regex -- refusing control characters is the point
    if (typeof v !== 'string' || !v || v.length > VIEWED_AT_LIMITS.name || /[\u0000-\u001f\u007f]/.test(v))
        return invalid(at, `Expected a name of 1 to ${VIEWED_AT_LIMITS.name} characters on one line.`);
    const made = make(v);
    return made.ok ? ok(made.value) : invalid(at, 'Not a valid name.');
}

/** A list of names, each once, at most `max`. */
function names<T>(v: unknown, at: string, max: number, make: (s: string) => Result<T, unknown>): Result<T[], InvalidViewedAt> {
    if (!Array.isArray(v) || v.length > max) return invalid(at, `Expected 0 to ${max} names.`);
    const out: T[] = [];
    for (const [i, item] of v.entries()) {
        const n = name(item, `${at}[${i}]`, make);
        if (!n.ok) return n;
        if (out.includes(n.value)) return invalid(`${at}[${i}]`, 'Each name once.');
        out.push(n.value);
    }
    return ok(out);
}

const bool = (v: unknown, at: string): Result<boolean, InvalidViewedAt> => (typeof v === 'boolean' ? ok(v) : invalid(at, 'Expected true or false.'));

function enumOf<T extends string>(v: unknown, at: string, values: readonly T[]): Result<T, InvalidViewedAt> {
    const found = values.find((x) => x === v);
    return found === undefined ? invalid(at, `Expected one of ${values.join(', ')}.`) : ok(found);
}

function viewShown(v: unknown, at: string): Result<Collaboration.ViewShown, InvalidViewedAt> {
    if (!isObject(v)) return invalid(at, 'Expected a view.');
    const f = (k: string): string => `${at}.${k}`;
    switch (v.kind) {
        case 'ContextMap': {
            const extra = only(v, ['kind', 'all'], at);
            if (extra) return err(extra);
            const all = bool(v.all, f('all'));
            return all.ok ? ok({ kind: 'ContextMap', all: all.value }) : all;
        }
        case 'Structure': {
            const extra = only(v, ['kind', 'level', 'focus'], at);
            if (extra) return err(extra);
            const level = enumOf<Collaboration.StructureDetail>(v.level, f('level'), ['Detail', 'Overview', 'Aggregates']);
            if (!level.ok) return level;
            const focus = names(v.focus ?? [], f('focus'), VIEWED_AT_LIMITS.contexts, Collaboration.makeContextName);
            return focus.ok ? ok({ kind: 'Structure', level: level.value, focus: focus.value }) : focus;
        }
        case 'Catalog': {
            const extra = only(v, ['kind', 'query', 'sections', 'contexts'], at);
            if (extra) return err(extra);
            let query: Collaboration.CatalogQuery | undefined;
            if (v.query !== undefined) {
                // oxlint-disable-next-line eslint/no-control-regex -- refusing control characters is the point
                if (typeof v.query !== 'string' || /[\u0000-\u001f\u007f]/.test(v.query)) return invalid(f('query'), 'Expected text on one line.');
                const trimmed = v.query.trim();
                if (trimmed) {
                    const q = Collaboration.makeCatalogQuery(trimmed);
                    if (!q.ok) return invalid(f('query'), `At most ${VIEWED_AT_LIMITS.query} characters.`);
                    query = q.value;
                }
            }
            const sections = names(v.sections ?? [], f('sections'), VIEWED_AT_LIMITS.sections, Collaboration.makeCatalogSection);
            if (!sections.ok) return sections;
            const contexts = names(v.contexts ?? [], f('contexts'), VIEWED_AT_LIMITS.contexts, Collaboration.makeContextName);
            if (!contexts.ok) return contexts;
            return ok({ kind: 'Catalog', ...(query && { query }), sections: sections.value, contexts: contexts.value });
        }
        case 'Storming': {
            const extra = only(v, ['kind', 'storming', 'level', 'timeline', 'stage', 'exceptions'], at);
            if (extra) return err(extra);
            const storming = name(v.storming, f('storming'), Collaboration.makeStormingName);
            if (!storming.ok) return storming;
            const level = enumOf<Collaboration.StormingLevel>(v.level, f('level'), ['BigPicture', 'DesignLevel']);
            if (!level.ok) return level;
            if (v.timeline !== undefined && v.stage !== undefined) return invalid(f('stage'), 'A timeline or a stage, not both.');
            const timeline = v.timeline === undefined ? undefined : name(v.timeline, f('timeline'), Collaboration.makeTimelineName);
            if (timeline && !timeline.ok) return timeline;
            const stage = v.stage === undefined ? undefined : name(v.stage, f('stage'), Collaboration.makeStageName);
            if (stage && !stage.ok) return stage;
            const exceptions = bool(v.exceptions ?? true, f('exceptions'));
            if (!exceptions.ok) return exceptions;
            return ok({
                kind: 'Storming',
                storming: storming.value,
                level: level.value,
                ...(timeline && { timeline: timeline.value }),
                ...(stage && { stage: stage.value }),
                exceptions: exceptions.value,
            });
        }
        default:
            return invalid(f('kind'), "Expected 'ContextMap', 'Structure', 'Catalog' or 'Storming'.");
    }
}

/** The view a page sent (`{ view, states? }`), checked: its shape and limits; whether its names exist is `resolveViewedAt`'s. */
export function readViewedAt(v: unknown, at = 'viewedAt'): Result<Collaboration.ViewedAt, InvalidViewedAt> {
    if (!isObject(v)) return invalid(at, 'Expected a view.');
    const extra = only(v, ['view', 'states'], at);
    if (extra) return err(extra);
    const view = viewShown(v.view, `${at}.view`);
    if (!view.ok) return view;
    if (v.states === undefined) return ok({ view: view.value });
    const states = name(v.states, `${at}.states`, Collaboration.makeElementName);
    return states.ok ? ok({ view: view.value, states: states.value }) : states;
}

/** The names of the workspace a view may use, as it is when a message is sent. */
export interface KnownViewNames {
    readonly contexts: ReadonlySet<string>;
    readonly aggregates: ReadonlySet<string>;
    /** By storming ID: its timelines and stages. */
    readonly stormings: ReadonlyMap<string, { readonly timelines: ReadonlySet<string>; readonly stages: ReadonlySet<string> }>;
}

/**
 * The view with the names the workspace does not have dropped: a storming not found drops the whole view (it would
 * point nowhere); a timeline or a stage not found leaves the storming's integrated canvas; contexts and an aggregate not
 * found are left out. The page only offers what the workspace showed it, so a dropped name is a page behind the files.
 */
export function resolveViewedAt(viewed: Collaboration.ViewedAt, known: KnownViewNames): Collaboration.ViewedAt | undefined {
    const states = viewed.states !== undefined && known.aggregates.has(viewed.states) ? { states: viewed.states } : {};
    const contexts = (list: readonly Collaboration.ContextName[]): Collaboration.ContextName[] => list.filter((c) => known.contexts.has(c));
    const v = viewed.view;
    switch (v.kind) {
        case 'ContextMap':
            return { view: v, ...states };
        case 'Structure':
            return { view: { ...v, focus: contexts(v.focus) }, ...states };
        case 'Catalog':
            return { view: { ...v, contexts: contexts(v.contexts) }, ...states };
        case 'Storming': {
            const storming = known.stormings.get(v.storming);
            if (!storming) return undefined;
            const { timeline, stage, ...rest } = v;
            return {
                view: {
                    ...rest,
                    ...(timeline !== undefined && storming.timelines.has(timeline) && { timeline }),
                    ...(stage !== undefined && storming.stages.has(stage) && { stage }),
                },
                ...states,
            };
        }
    }
}

/** A value with its branded strings plain: a view as the model has it, or as JSON carries it (the agent's). */
type Plain<T> = T extends string & { readonly __domain: string }
    ? string
    : T extends string | number | boolean | undefined
      ? T
      : { readonly [K in keyof T]: Plain<T[K]> };

/** A view as the model has it or as JSON carries it. */
export type ViewedAtLike = Plain<Collaboration.ViewedAt>;

/**
 * The view as the AI's prompts show it, in the data block: `{ view: 'storming', storming: '@{es:Returns}', level:
 * 'design', stage, exceptions: true }`. Elements are named as the replies name them (`@{…}`).
 */
export function viewedAtData(viewed: ViewedAtLike): Record<string, unknown> {
    const states = viewed.states === undefined ? {} : { stateDiagramOf: `@{${viewed.states}}` };
    const v = viewed.view;
    switch (v.kind) {
        case 'ContextMap':
            return { view: 'context map', ...(v.all && { allContexts: true }), ...states };
        case 'Structure':
            return {
                view: 'structure',
                detail: v.level === 'Detail' ? 'detail' : v.level === 'Overview' ? 'overview' : 'aggregates',
                ...(v.focus.length > 0 && { contexts: v.focus }),
                ...states,
            };
        case 'Catalog':
            return {
                view: 'catalog',
                ...(v.query !== undefined && { filter: v.query }),
                ...(v.sections.length > 0 && { sections: v.sections }),
                ...(v.contexts.length > 0 && { contexts: v.contexts }),
                ...states,
            };
        case 'Storming':
            return {
                view: 'storming',
                storming: `@{es:${v.storming}}`,
                level: v.level === 'DesignLevel' ? 'design' : 'big picture',
                ...(v.stage !== undefined && { stage: v.stage }),
                ...(v.timeline !== undefined && { timeline: v.timeline }),
                exceptions: v.exceptions,
                ...states,
            };
    }
}
