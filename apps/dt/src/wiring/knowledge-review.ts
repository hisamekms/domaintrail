// The knowledge side of the review at the end of an AI run (ADR 0034): which items the agent is given to check its
// neighbourhood against, and the links of the items about a sticky the run renamed, moved to its new name.
//
// - **Which items**: those about the neighbourhood's stickies, never AS-IS (what was is no ground for a mismatch with
//   what is decided): decisions first, then rules, then the other kinds; each group newest first; at most
//   `REVIEW_KNOWLEDGE_MAX`, their text cut to `REVIEW_KNOWLEDGE_TEXT` characters.
// - **Renames**: a sticky renamed (`<Storming>.<Old>` → `<Storming>.<New>`) breaks the `about` of its items, which
//   name it by ID. Each such item is corrected to name the new one (a new version, by `dt`): a repair, not a change of
//   what it says. Its text, labels and the other stickies stay.
// - **Retirements the review proposes** (ADR 0031 §12): only of the items it was given, each with its reason, its
//   explanation and its evidence (a sticky the run changed, a decision), proposed by the review of the run
//   (`run:<id>`) through `KnowledgeStore.propose`, which refuses what `admitProposal` refuses (an AS-IS item against
//   the TO-BE, one dismissed before on the same evidence, one already waiting). People decide in 廃止の候補.
import type { ReviewRetireData, StickyRename } from '@domaintrail/collaboration';
import type { AgentReviewKnowledge } from '@domaintrail/collaboration/protocol';
import { Knowledge, type KnowledgeStore, proposeRetirements, readRetirementCandidates } from '@domaintrail/knowledge';

/** The most items a review gives the agent. */
export const REVIEW_KNOWLEDGE_MAX = 12;
/** The most characters of an item's text a review gives. */
export const REVIEW_KNOWLEDGE_TEXT = 600;
/** Who relinks an item's stickies after a rename, in its versions and the audit log. */
export const RELINKED_BY = 'dt';

/** The order of the kinds: decisions, then rules, then the rest. */
const KIND_ORDER: Readonly<Partial<Record<Knowledge.KnowledgeKind, number>>> = { decision: 0, rule: 1 };

/** The items a review gives the agent, from those about its neighbourhood (see the head of this file). */
export function reviewKnowledgeOf(items: readonly Knowledge.LiveKnowledgeItem[], max = REVIEW_KNOWLEDGE_MAX): AgentReviewKnowledge[] {
    const rank = (i: Knowledge.LiveKnowledgeItem): number => KIND_ORDER[i.content.labels.kind] ?? 2;
    return items
        .filter((i) => i.content.labels.when !== 'as_is')
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item) - rank(b.item) || b.item.createdAt.getTime() - a.item.createdAt.getTime() || a.index - b.index)
        .slice(0, max)
        .map(({ item }) => ({
            id: item.id,
            title: item.content.title,
            text: item.content.text.length > REVIEW_KNOWLEDGE_TEXT ? `${item.content.text.slice(0, REVIEW_KNOWLEDGE_TEXT)}…` : item.content.text,
            kind: item.content.labels.kind,
            when: item.content.labels.when,
            about: [...item.content.about],
            createdAt: item.createdAt.toISOString(),
        }));
}

/** The sticky references of `refs` that are references (the others are left out). */
export function stickyRefs(refs: readonly string[]): Knowledge.StickyRef[] {
    return refs.flatMap((r) => {
        const made = Knowledge.makeStickyRef(r);
        return made.ok ? [made.value] : [];
    });
}

/**
 * Moves the links of the items about each renamed sticky to its new name; how many items were corrected. An item that
 * cannot be corrected (deleted meanwhile) is skipped and logged.
 */
export async function relinkRenamed(
    store: KnowledgeStore,
    project: Knowledge.ProjectName,
    renames: readonly StickyRename[],
    log: (line: string) => void,
): Promise<number> {
    const by = Knowledge.makeUserName(RELINKED_BY);
    if (!by.ok) throw new Error('The name dt relinks by is not a user name');
    let relinked = 0;
    for (const r of renames) {
        const [from, to] = stickyRefs([`${r.storming}.${r.from}`, `${r.storming}.${r.to}`]);
        if (from === undefined || to === undefined) continue;
        for (const item of await store.about(project, [from])) {
            const about = [...new Set(item.content.about.map((a) => (a === from ? to : a)))];
            const corrected = await store.correct(project, item.id, { ...item.content, about }, by.value);
            if (corrected.ok) relinked++;
            else log(`knowledge: ${item.id} not relinked to ${to} (${corrected.error.type})`);
        }
    }
    return relinked;
}

/** What became of the retirements a review proposed: those the store took (new or made before), and those it did not. */
export interface ReviewProposals {
    readonly proposed: number;
    readonly refused: number;
}

/**
 * Proposes the retirements a run's review gave (`retire`) to the store, as the review `run:<run>`: only those of the
 * items it was given (`given`); a malformed one, and one the store refuses, are logged (kinds only, never a text).
 */
export async function proposeReviewRetirements(
    store: KnowledgeStore,
    project: Knowledge.ProjectName,
    run: string,
    retire: readonly ReviewRetireData[],
    given: ReadonlySet<string>,
    log: (line: string) => void,
): Promise<ReviewProposals> {
    const asked = retire.filter((r) => given.has(r.item));
    if (asked.length < retire.length) log(`knowledge: run ${run}: ${retire.length - asked.length} retirement(s) of items the review was not given left out`);
    if (asked.length === 0) return { proposed: 0, refused: 0 };
    const review = Knowledge.makeReviewRef(`run:${run}`);
    if (!review.ok) throw new Error('A run is not a review reference');
    const read = readRetirementCandidates(
        asked.map((r) => ({ ...r, action: 'retire' })),
        review.value,
    );
    for (const r of read.rejected) log(`knowledge: run ${run}: a retirement left out (${r.path}: ${r.message})`);
    let proposed = 0;
    let refused = 0;
    for (const o of await proposeRetirements(store, project, read.candidates)) {
        if (o.result.ok) proposed++;
        else {
            refused++;
            log(
                `knowledge: run ${run}: a retirement not proposed (${o.result.error.type === 'ProposalRefused' ? o.result.error.reason : o.result.error.type})`,
            );
        }
    }
    return { proposed, refused };
}
