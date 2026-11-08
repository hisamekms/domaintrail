/**
 * The gaps of a storming's Design Level (ADR 0032): what a command, a policy or an element lacks to be a whole row of
 * Event Storming's grammar, and the open hotspot that asks about it, if any. The validator reports a gap without a
 * question (S024, S008, S027); `dt check` lists those an open hotspot keeps open, and the Live View draws their empty
 * slots, so that a silenced gap stays visible.
 */
import { isRemovedKeyword, REMOVED_KEYWORDS, type NodeElement, type NodeElementKind, type RelationKeyword, type Storming } from './ir.js';
import { firstDeclarations } from './semantic.js';

/** What a sticky may lack: a command's issuer (`by`, or a policy), `handledBy` or `emits`; a policy's `on` or `issues`; an element's use. */
export type Missing = 'by' | 'handledBy' | 'emits' | 'on' | 'issues' | 'use';

export interface Gap {
    /** The local ID of the element. */
    elementId: string;
    kind: NodeElementKind;
    missing: Missing[];
    /** The open hotspot `on` it, which asks about it: the gap is then a question, not an error. */
    question?: string;
}

/** Whether an element has a relation clause with `keyword`, whatever its target (`actor` and `target` count as `by` and `handledBy`). */
export const hasRelation = (el: NodeElement, keyword: RelationKeyword): boolean =>
    el.clauses.some((c) => c.type === 'relation' && (isRemovedKeyword(c.keyword) ? REMOVED_KEYWORDS[c.keyword] : c.keyword) === keyword);

/** Whether a storming has Design Level content: a command or a policy. Without it, nothing is a gap (Big Picture). */
export const hasDesignLevel = (storming: Storming): boolean => storming.elements.some((el) => el.kind === 'command' || el.kind === 'policy');

/**
 * The open hotspots of a storming, by the element they are `on`: each hotspot by its first `on` only (the one that is
 * an edge; a second one is S004), and only while it is not `status resolved`. The first hotspot on an element wins.
 */
export function openQuestions(storming: Storming): Map<string, string> {
    const byId = firstDeclarations(storming);
    const out = new Map<string, string>();
    for (const d of byId.values()) {
        if (d.kind !== 'hotspot') continue;
        if (d.clauses.find((c) => c.type === 'status')?.value === 'resolved') continue;
        const on = d.clauses.find((c) => c.type === 'relation' && c.keyword === 'on');
        if (on?.type === 'relation' && !out.has(on.target)) out.set(on.target, d.id);
    }
    return out;
}

/** Every gap of a storming's Design Level, in source order, with the open hotspot asking about it when there is one. */
export function designGaps(storming: Storming): Gap[] {
    if (!hasDesignLevel(storming)) return [];
    const byId = firstDeclarations(storming);
    const questions = openQuestions(storming);
    const nodes = [...byId.values()].filter((d): d is NodeElement => 'clauses' in d);
    /** The elements another element's relation names (a hotspot's `on` aside). */
    const named = new Set<string>();
    const issued = new Set<string>();
    for (const d of nodes) {
        if (d.kind === 'hotspot') continue;
        for (const c of d.clauses) {
            if (c.type !== 'relation') continue;
            named.add(c.target);
            if (d.kind === 'policy' && c.keyword === 'issues' && byId.get(c.target)?.kind === 'command') issued.add(c.target);
        }
    }
    const gaps: Gap[] = [];
    for (const el of nodes) {
        const missing: Missing[] = [];
        if (el.kind === 'command') {
            if (!hasRelation(el, 'by') && !issued.has(el.id)) missing.push('by');
            if (!hasRelation(el, 'handledBy')) missing.push('handledBy');
            if (!hasRelation(el, 'emits')) missing.push('emits');
        } else if (el.kind === 'policy') {
            if (!hasRelation(el, 'on')) missing.push('on');
            if (!hasRelation(el, 'issues')) missing.push('issues');
        } else if (el.kind === 'actor' || el.kind === 'external' || el.kind === 'aggregate' || el.kind === 'readmodel') {
            // an element's own relations are its part too: a read model fed `from` events that people only look at
            if (!named.has(el.id) && !el.clauses.some((c) => c.type === 'relation')) missing.push('use');
        }
        if (!missing.length) continue;
        const question = questions.get(el.id);
        gaps.push({ elementId: el.id, kind: el.kind, missing, ...(question !== undefined && { question }) });
    }
    return gaps;
}

/** The gaps an open hotspot keeps open: not errors, still to be decided. */
export const openGaps = (storming: Storming): Gap[] => designGaps(storming).filter((g) => g.question !== undefined);
