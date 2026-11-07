// The review at the end of an AI run (ADR 0034): what the run's diff of the stormings shows by rule (stage 0), the
// stickies it renamed (whose knowledge is linked to the new name), and the neighbourhood of what it changed that the
// agent checks against the requests and the decisions before the run ends (stage 1). Decided without I/O, from the
// storming IR before and after the run.
//
// Stage 0's rules, each about this run's changes only:
// - **ResolvedUnchanged**: a hotspot open before (or without a status) is resolved now, and the sticky it is `on` is
//   as it was (its declaration reads the same): the decision was written down, the drawing was not changed;
// - **ChangedOpen**: a sticky the run changed (not added) has a hotspot `on` it that is open now and that the run did
//   not touch (its question, status and resolution as they were): the drawing changed, the question was not answered;
// - **StaleWording**: a sticky the run relabelled or renamed, whose label or name before is still another sticky's of
//   the same kind, in any storming (a rename left behind elsewhere);
// - **DuplicateLabel**: a sticky the run added has the label of another sticky of the same kind, with another ID, in
//   any storming.
//
// A rename is a sticky removed and one added in the same storming, of the same kind, with the same label or the same
// relations (the other stickies it points at and that point at it, by their names after the run); only a one-to-one
// match counts.
import { firstDeclarations, nodeElements, type NodeElement, type Storming } from '@domaintrail/storming';
import { Collaboration, type Result } from '../generated/index.js';

export type ReviewFindingKind = Collaboration.ReviewFindingKind;

/** Where a sticky is: its storming and its local ID. */
export interface StickyPlace {
    readonly storming: string;
    readonly element: string;
}

/** What stage 0 found: the sticky (a hotspot for the pairs), and its counterpart. */
export interface ReviewFindingData extends StickyPlace {
    readonly kind: ReviewFindingKind;
    /** The counterpart: the hotspot's sticky (the pairs), the sticky with the old wording, the one with the same label. */
    readonly other?: StickyPlace;
    /** The label or name before (`StaleWording`). */
    readonly was?: string;
}

/** A sticky the run renamed: its storming, its name before and after. */
export interface StickyRename {
    readonly storming: string;
    readonly from: string;
    readonly to: string;
}

/** A sticky of the neighbourhood, as the agent is given it. */
export interface NeighbourSticky extends StickyPlace {
    readonly kind: string;
    readonly label?: string;
    /** A hotspot's state: `open` or `resolved`. */
    readonly status?: 'open' | 'resolved';
    /** Why it is in the neighbourhood: the run changed it, it is a hotspot on one, it is one step away, stage 0 found it. */
    readonly why: 'changed' | 'hotspot' | 'next' | 'found';
}

export interface StormingReview {
    readonly findings: readonly ReviewFindingData[];
    readonly renames: readonly StickyRename[];
    /** The stickies the agent checks: changed ones, their hotspots, one step of relations, those stage 0 found. */
    readonly neighbourhood: readonly NeighbourSticky[];
}

/** The most stickies a neighbourhood holds: the changed ones first. */
export const MAX_NEIGHBOURHOOD = 80;
/** The most findings kept of one review. */
export const MAX_FINDINGS = 50;

/** A value without its source ranges: what it says, wherever it is written. */
function withoutRanges(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutRanges);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value).flatMap(([k, v]) => (k === 'range' || k === 'nameRange' || k === 'targetRange' ? [] : [[k, withoutRanges(v)]])),
    );
}

const fingerprint = (el: NodeElement): string => JSON.stringify(withoutRanges(el));

/** A hotspot's status as read: `resolved` only when written so (a missing or invalid one is open). */
const statusOf = (el: NodeElement): 'open' | 'resolved' => (el.clauses.some((c) => c.type === 'status' && c.value === 'resolved') ? 'resolved' : 'open');

/** What a hotspot says of itself: its question, status and resolution (not what it is `on`). */
const hotspotWords = (el: NodeElement): string =>
    JSON.stringify([el.label ?? '', statusOf(el), el.clauses.flatMap((c) => (c.type === 'resolution' ? [c.text] : []))]);

/** The targets of an element's relation clauses (a hotspot's `on` among them). */
const targetsOf = (el: NodeElement, keyword?: string): string[] =>
    el.clauses.flatMap((c) => (c.type === 'relation' && (keyword === undefined || c.keyword === keyword) ? [c.target] : []));

/** The node elements of a storming by local ID (the first of a duplicated ID). */
function nodesOf(s: Storming): Map<string, NodeElement> {
    const out = new Map<string, NodeElement>();
    for (const d of firstDeclarations(s).values()) if (d.kind !== 'timeline' && d.kind !== 'group' && d.kind !== 'stage') out.set(d.id, d);
    return out;
}

/** An element's neighbours in its storming: what it points at, and what points at it, by local ID. */
function neighboursOf(s: Storming, id: string): Set<string> {
    const out = new Set<string>();
    for (const el of nodeElements(s)) {
        if (el.id === id) for (const t of targetsOf(el)) out.add(t);
        else if (targetsOf(el).includes(id)) out.add(el.id);
    }
    out.delete(id);
    return out;
}

const normalized = (label: string | undefined): string | undefined => {
    const t = label?.replace(/\s+/g, ' ').trim();
    return t ? t : undefined;
};

/** The renames of one storming: removed and added stickies of the same kind with the same label or relations, one to one. */
function renamesOf(before: Storming, after: Storming): StickyRename[] {
    const was = nodesOf(before);
    const is = nodesOf(after);
    const removed = [...was.values()].filter((el) => !is.has(el.id));
    const added = [...is.values()].filter((el) => !was.has(el.id));
    if (removed.length === 0 || added.length === 0) return [];
    // the relations of a removed sticky, read with the names after the run: the stickies it pointed at, and those that
    // pointed at it (by a name the run kept, or the new one)
    const relationsBefore = (el: NodeElement, to: string): string => {
        const out = new Set(neighboursOf(before, el.id));
        // a neighbour that is itself renamed is not followed: its name differs either way
        return JSON.stringify([...out].filter((n) => is.has(n) && n !== to).sort());
    };
    const relationsAfter = (el: NodeElement): string => JSON.stringify([...neighboursOf(after, el.id)].filter((n) => was.has(n)).sort());
    const candidates = new Map<string, string[]>();
    for (const r of removed) {
        const matches = added.filter((a) => {
            if (a.kind !== r.kind) return false;
            const sameLabel = normalized(a.label) !== undefined && normalized(a.label) === normalized(r.label);
            const rel = relationsAfter(a);
            const sameRelations = rel !== '[]' && rel === relationsBefore(r, a.id);
            return sameLabel || sameRelations;
        });
        candidates.set(
            r.id,
            matches.map((m) => m.id),
        );
    }
    const out: StickyRename[] = [];
    for (const [from, tos] of candidates) {
        if (tos.length !== 1) continue;
        const to = tos[0];
        // one to one: no other removed sticky matches the same added one
        if ([...candidates.entries()].some(([other, o]) => other !== from && o.includes(to))) continue;
        out.push({ storming: after.id, from, to });
    }
    return out;
}

/**
 * The review of a run from the stormings before and after it: stage 0's findings, the renames, and the neighbourhood.
 * A storming added or removed whole is no rename; its stickies count as added (or are gone).
 */
export function reviewStormings(before: readonly Storming[], after: readonly Storming[]): StormingReview {
    const beforeById = new Map(before.map((s) => [s.id, s]));
    const findings: ReviewFindingData[] = [];
    const renames: StickyRename[] = [];
    /** Per storming after the run: the stickies the run changed (or renamed to), and those it added (not renamed). */
    const changedIn = new Map<string, Set<string>>();
    const addedIn = new Map<string, Set<string>>();
    /** The wording the run left behind: per kind, the labels and names before a change. */
    const oldWords: { storming: string; element: string; kind: string; label?: string; name?: string }[] = [];

    for (const s of after) {
        const old = beforeById.get(s.id);
        const was = old ? nodesOf(old) : new Map<string, NodeElement>();
        const is = nodesOf(s);
        const renamed = old ? renamesOf(old, s) : [];
        renames.push(...renamed);
        const renamedTo = new Map(renamed.map((r) => [r.to, r.from]));
        const changed = new Set<string>();
        const added = new Set<string>();
        for (const el of is.values()) {
            const from = renamedTo.get(el.id);
            const o = was.get(from ?? el.id);
            if (!o) {
                added.add(el.id);
                continue;
            }
            if (from !== undefined || fingerprint(o) !== fingerprint(el)) {
                changed.add(el.id);
                if (el.kind !== 'hotspot') {
                    const label = normalized(o.label) !== normalized(el.label) ? normalized(o.label) : undefined;
                    if (label !== undefined || from !== undefined)
                        oldWords.push({
                            storming: s.id,
                            element: el.id,
                            kind: el.kind,
                            ...(label !== undefined && { label }),
                            ...(from !== undefined && { name: from }),
                        });
                }
            }
        }
        changedIn.set(s.id, changed);
        addedIn.set(s.id, added);

        // the pairs of a hotspot and its sticky
        for (const h of is.values()) {
            if (h.kind !== 'hotspot') continue;
            const hBefore = was.get(renamedTo.get(h.id) ?? h.id);
            const onNow = targetsOf(h, 'on');
            if (hBefore && statusOf(hBefore) === 'open' && statusOf(h) === 'resolved') {
                for (const on of onNow) {
                    const sticky = is.get(on);
                    const stickyBefore = was.get(renamedTo.get(on) ?? on);
                    if (sticky && stickyBefore && renamedTo.get(on) === undefined && fingerprint(sticky) === fingerprint(stickyBefore))
                        findings.push({ kind: 'ResolvedUnchanged', storming: s.id, element: h.id, other: { storming: s.id, element: on } });
                }
            }
            const untouched = hBefore !== undefined && hotspotWords(hBefore) === hotspotWords(h);
            if (statusOf(h) === 'open' && untouched)
                for (const on of onNow)
                    if (changed.has(on) && is.get(on)?.kind !== 'hotspot')
                        findings.push({ kind: 'ChangedOpen', storming: s.id, element: h.id, other: { storming: s.id, element: on } });
        }
    }

    // the old wording still used, and the labels taken twice: in every storming after the run
    const all = after.flatMap((s) => [...nodesOf(s).values()].filter((el) => el.kind !== 'hotspot').map((el) => ({ storming: s.id, el })));
    for (const w of oldWords) {
        for (const { storming, el } of all) {
            if (el.kind !== w.kind || (storming === w.storming && el.id === w.element)) continue;
            // a sticky the run itself changed or added says what the run meant: not left behind
            if (changedIn.get(storming)?.has(el.id) || addedIn.get(storming)?.has(el.id)) continue;
            const label = normalized(el.label);
            if (w.label !== undefined && label === w.label)
                findings.push({ kind: 'StaleWording', storming, element: el.id, other: { storming: w.storming, element: w.element }, was: w.label });
            else if (w.name !== undefined && el.id === w.name)
                findings.push({ kind: 'StaleWording', storming, element: el.id, other: { storming: w.storming, element: w.element }, was: w.name });
        }
    }
    const afterById = new Map(after.map((s) => [s.id, s]));
    for (const [storming, added] of addedIn) {
        const s = afterById.get(storming);
        const nodes = s ? nodesOf(s) : new Map<string, NodeElement>();
        for (const id of added) {
            const el = nodes.get(id);
            const label = normalized(el?.label);
            if (!el || el.kind === 'hotspot' || label === undefined) continue;
            const twin = all.find((x) => x.el.kind === el.kind && normalized(x.el.label) === label && !(x.storming === storming && x.el.id === id));
            if (twin && twin.el.id !== id)
                findings.push({ kind: 'DuplicateLabel', storming, element: id, other: { storming: twin.storming, element: twin.el.id } });
        }
    }

    // the neighbourhood starts from every sticky the run changed or added
    const touched = new Map([...changedIn].map(([s, ids]) => [s, new Set([...ids, ...(addedIn.get(s) ?? [])])]));
    return { findings: dedupe(findings).slice(0, MAX_FINDINGS), renames, neighbourhood: neighbourhoodOf(after, touched, findings) };
}

/** Each finding once (two hotspots' pairs may name the same sticky; that is two findings, not the same one twice). */
function dedupe(findings: readonly ReviewFindingData[]): ReviewFindingData[] {
    const seen = new Set<string>();
    return findings.filter((f) => {
        const key = findingKey(f);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** A finding's identity: what it is, where, and with what (the same in the review and in what is left after it). */
export const findingKey = (f: ReviewFindingData): string =>
    JSON.stringify([f.kind, f.storming, f.element, f.other?.storming ?? '', f.other?.element ?? '', f.was ?? '']);

/**
 * The neighbourhood: the stickies the run changed or added, the hotspots on them, one step of relations from them
 * (commands, who issues and handles them, events, policies, read models), and the stickies stage 0 found; at most
 * `MAX_NEIGHBOURHOOD`, in that order.
 */
function neighbourhoodOf(
    after: readonly Storming[],
    changedIn: ReadonlyMap<string, ReadonlySet<string>>,
    findings: readonly ReviewFindingData[],
): NeighbourSticky[] {
    const out = new Map<string, NeighbourSticky>();
    const add = (s: Storming, id: string, why: NeighbourSticky['why']): void => {
        const key = `${s.id}.${id}`;
        if (out.has(key) || out.size >= MAX_NEIGHBOURHOOD) return;
        const el = nodesOf(s).get(id);
        if (!el) return;
        out.set(key, {
            storming: s.id,
            element: id,
            kind: el.kind,
            ...(el.label !== undefined && { label: el.label }),
            ...(el.kind === 'hotspot' && { status: statusOf(el) }),
            why,
        });
    };
    const touched = (s: Storming): string[] => [...(changedIn.get(s.id) ?? [])];
    for (const s of after) for (const id of touched(s)) add(s, id, 'changed');
    for (const s of after)
        for (const el of nodeElements(s)) if (el.kind === 'hotspot' && targetsOf(el, 'on').some((on) => changedIn.get(s.id)?.has(on))) add(s, el.id, 'hotspot');
    for (const s of after) for (const id of touched(s)) for (const n of neighboursOf(s, id)) add(s, n, 'next');
    for (const f of findings) {
        for (const p of [f, ...(f.other ? [f.other] : [])]) {
            const s = after.find((x) => x.id === p.storming);
            if (s) add(s, p.element, 'found');
        }
    }
    return [...out.values()];
}

/** A value made by a generated factory from what the IR already holds (an ID, a label); anything else is a bug. */
function made<T>(r: Result<T, unknown>): T {
    if (!r.ok) throw new Error('A storming IR value did not make a value of the model');
    return r.value;
}

const stickyOf = (p: StickyPlace): Collaboration.ReviewSticky => ({
    storming: made(Collaboration.makeStormingName(p.storming)),
    element: made(Collaboration.makeStormingLocalName(p.element)),
});

/** Stage 0's findings as the model's values (a run's review keeps them). */
export function reviewFindings(findings: readonly ReviewFindingData[]): Collaboration.ReviewFinding[] {
    return findings.slice(0, MAX_FINDINGS).map((f) => ({
        kind: f.kind,
        sticky: stickyOf(f),
        ...(f.other && { other: stickyOf(f.other) }),
        ...(f.was !== undefined && { was: made(Collaboration.makeText(f.was)) }),
    }));
}

/** A finding the model keeps, as the domain reads it. */
export const findingData = (f: Collaboration.ReviewFinding): ReviewFindingData => ({
    kind: f.kind,
    storming: f.sticky.storming,
    element: f.sticky.element,
    ...(f.other && { other: { storming: f.other.storming, element: f.other.element } }),
    ...(f.was !== undefined && { was: f.was }),
});

/** What the agent says of its review (untrusted, validated by its limits): what it fixed, and what it kept and why. */
export interface AgentReviewReport {
    readonly fixed: readonly Collaboration.Text[];
    readonly kept: readonly Collaboration.KeptFinding[];
}

/** The most items the agent's report of its review keeps of each list (the model's `RunReview`). */
export const REVIEW_REPORT_LIMITS = { fixed: 10, kept: 10, text: 300 } as const;

/**
 * A run's review, as it is kept: what stage 0 found right after the agent's work (`found`; none when stage 1 never asked),
 * what it still finds once the run ends (`left`), and the agent's report. None when there is nothing to tell: no
 * finding before or after, and the agent was not asked.
 */
export function runReview(input: {
    readonly found: readonly Collaboration.ReviewFinding[] | undefined;
    readonly left: readonly ReviewFindingData[];
    readonly report: AgentReviewReport | undefined;
}): Collaboration.RunReview | undefined {
    const asked = input.found !== undefined;
    const found = input.found ?? reviewFindings(input.left);
    if (!asked && found.length === 0) return undefined;
    return {
        found: found.slice(0, MAX_FINDINGS),
        left: reviewFindings(input.left),
        fixed: (input.report?.fixed ?? []).slice(0, REVIEW_REPORT_LIMITS.fixed),
        kept: (input.report?.kept ?? []).slice(0, REVIEW_REPORT_LIMITS.kept),
        asked,
    };
}
