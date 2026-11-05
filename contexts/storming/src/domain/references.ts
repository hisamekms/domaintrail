/**
 * The places of a storming that name one of its declarations by its local ID (docs/dtes-v0.1.md §2, §3.2, §3.4,
 * §3.7), and what a local ID may be: what a rename of a sticky rewrites, and checks first (ADR 0033). Read from the IR,
 * so that the page counts them without a parser; the rewrite itself (`planStickyEdit`) goes through the AST and must
 * find the same places (its tests compare the two).
 */
import { allTimelines, nodeElements, type SourceRange, type Storming } from './ir.js';

/** Where a reference to a declaration is written, by the clause or step that writes it. */
export type ReferenceSite =
    /** `emits X`, `on X`, `issues X`, `actor X`, `reads X`, `target X` in an element's body. */
    | 'relation'
    /** An event step of a timeline, or an event of a group. */
    | 'step'
    /** An exception's `then X`. */
    | 'rejoin'
    /** A stage's `after X`. */
    | 'after';

/** A reference to a declaration: where it is written and of which kind. */
export interface StormingReference {
    readonly site: ReferenceSite;
    readonly range: SourceRange;
}

/**
 * Every reference to `id` in a storming, in source order of the elements: the relation clauses, the timelines' steps
 * (a group's events included), the exceptions' `then` and the stages' `after`. The declaration itself is not one.
 */
export function referencesTo(storming: Storming, id: string): StormingReference[] {
    const out: StormingReference[] = [];
    for (const el of nodeElements(storming))
        for (const c of el.clauses) if (c.type === 'relation' && c.target === id) out.push({ site: 'relation', range: c.targetRange });
    for (const el of storming.elements) if (el.kind === 'stage') for (const a of el.afters) if (a.stageId === id) out.push({ site: 'after', range: a.range });
    for (const t of allTimelines(storming)) {
        for (const s of t.steps) {
            if (s.type === 'event') {
                if (s.eventId === id) out.push({ site: 'step', range: s.range });
            } else for (const e of s.events) if (e.eventId === id) out.push({ site: 'step', range: e.range });
        }
        if (t.rejoin?.eventId === id) out.push({ site: 'rejoin', range: t.rejoin.range });
    }
    return out;
}

/** The keywords of `.dtes`: a local ID cannot be one (the lexer reads it as the keyword). */
export const STORMING_KEYWORDS: ReadonlySet<string> = new Set([
    'storming',
    'event',
    'actor',
    'external',
    'command',
    'policy',
    'aggregate',
    'readmodel',
    'hotspot',
    'timeline',
    'group',
    'ref',
    'reads',
    'target',
    'emits',
    'on',
    'issues',
    'status',
    'resolution',
    'level',
    'stage',
    'after',
    'then',
    'exception',
]);

/** Why a local ID cannot be used. */
export type LocalNameProblem = 'format' | 'keyword' | 'duplicate';

/**
 * Whether `name` can name a declaration of `storming` (the grammar's ID: a letter or `_`, then letters, digits or `_`;
 * not a keyword; not the ID of another declaration of the storming, the declarations sharing one namespace). `own` is
 * the ID the declaration has now (keeping it is no duplicate).
 */
export function localNameProblem(name: string, taken: ReadonlySet<string>, own?: string): LocalNameProblem | undefined {
    if (!/^[_a-zA-Z]\w*$/.test(name)) return 'format';
    if (STORMING_KEYWORDS.has(name)) return 'keyword';
    if (name !== own && taken.has(name)) return 'duplicate';
    return undefined;
}
