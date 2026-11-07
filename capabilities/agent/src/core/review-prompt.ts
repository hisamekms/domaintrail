// The review at the end of a run (ADR 0034, stage 1): once the agent carried out the requests, it is given what dt's
// rules found in its changes (stage 0), the neighbourhood of what it changed and the knowledge about it, and checks
// them against the requests and the decisions — in the same run, as one more turn of the same conversation (a warm
// agent remembers its work), or, for an agent that starts afresh, with the run's whole prompt before it. What it finds
// it fixes within the requests' scope; what it keeps it says why. Its reply is the run's reply shape with `review`.
import type { AgentReviewBody } from '@domaintrail/collaboration/protocol';
import { REPLY_LIMITS } from '@domaintrail/collaboration';
import { RETIREMENT_PROPOSAL_RULES } from './extract-prompt.js';

/** JSON that cannot close the block it is in: `<` and `>` are escaped (JSON reads them back unchanged). */
const blockJson = (value: unknown): string => JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** Whether a review has anything for the agent to check: a finding, or a neighbourhood. */
export const hasReview = (review: AgentReviewBody): boolean => review.findings.length > 0 || review.neighbourhood.length > 0;

/** What each of stage 0's findings asks of the agent, by its kind. */
const FINDINGS = `- \`ResolvedUnchanged\`: you resolved the hotspot \`sticky\`, but the sticky it is on (\`other\`) is as it was. A
  decision that answers a hotspot changes the stickies too: change \`other\` as the decision says, or say why it needs
  no change.
- \`ChangedOpen\`: you changed \`other\`, but the hotspot \`sticky\` on it is still open and you did not touch it. If
  your change answers its question, resolve it (\`status resolved\` and \`resolution "…"\`); if not, leave it open and
  say why.
- \`StaleWording\`: \`sticky\` still has the label or name \`was\` that you changed on \`other\`. If both are the same
  thing, give \`sticky\` the new wording too; if not, say why.
- \`DuplicateLabel\`: the sticky you added (\`sticky\`) has the label of \`other\`, which has another identifier. If they
  are the same thing, keep one; if not, tell them apart.`;

/** What the review may propose about knowledge besides naming it (ADR 0031 §12): to retire an item, people deciding. */
const RETIRE = `
- \`retire\`: an item of \`review.knowledge\` that no longer holds because of what this run did by the requests, which
  you propose a person retire (at most ${REPLY_LIMITS.reviewRetire}): \`item\`, \`reason\` (\`replaced\` by a newer item of
  \`review.knowledge\`, given as \`replacedBy\`; \`obsolete\`: true before, not now; \`wrong\`: never true), \`explanation\`
  (why, in the requests' language), and \`evidence\` (1 to ${REPLY_LIMITS.reviewEvidence}): \`{ "kind": "StickyChange",
  "sticky": "Storming.Element", "change": "what changed" }\` for a sticky this run changed, or \`{ "kind": "Decision",
  "item": "kn_…" }\` for a decision of \`review.knowledge\` that overturns it. Nothing is retired by you; an item you
  retire is also in \`knowledge\` when the talk should settle it. ${RETIREMENT_PROPOSAL_RULES.replace(/\n/g, '\n  ')}`;

/** The review's instructions and data, as the turn after the work gives them (the rules of the run still hold). */
function reviewText(review: AgentReviewBody, nonce: string): string {
    const L = REPLY_LIMITS;
    const data = {
        found: review.findings,
        neighbourhood: review.neighbourhood,
        ...(review.renamed && review.renamed.length > 0 && { renamed: review.renamed }),
        ...(review.knowledge && review.knowledge.length > 0 && { knowledge: review.knowledge }),
    };
    return `Before this run ends, review your work: this is part of the same run, and the requests are still what to do.

\`review.found\` is what dt's rules found in your changes (each names stickies as storming and element):
${FINDINGS}

\`review.neighbourhood\` lists the stickies you changed or added (\`why\` "changed"), the hotspots on them ("hotspot"),
the stickies one relation away ("next") and those found above ("found"). Read them in the files and check them against
the requests, the answers and \`sessionSoFar\`${review.knowledge && review.knowledge.length > 0 ? `, and against \`review.knowledge\`: what the project decided and its rules about these stickies (TO-BE, or with no "when"; what was AS-IS is never a reason to change a sticky; a sticky you renamed, \`review.renamed\`, is still named there by its old name)` : ''}: is anything there at odds with what was asked or decided?

Fix what you find within the requests' scope, as you did the rest of the work (the rules above still hold: \`.dt\` and
\`.dtes\` files only, people's wording kept). Start nothing new, and leave a sticky as it is when it is not at odds.

Reply as before — \`outcome\` "done", the same \`title\`, a \`summary\` of one sentence on what this review did,
\`requests\` an empty list — with \`review\`:
- \`fixed\`: what you changed in this review, one short line each (at most ${L.reviewFixed}, ${L.reviewText} characters
  each), naming elements as \`@{es:Storming/Element}\`;
- \`kept\`: each finding of \`review.found\` you left as it is, \`what\` (the finding in a few words, naming its
  elements, never the rule's name: people read it) and \`why\`;
- \`knowledge\`: the items of \`review.knowledge\` now at odds with the stickies as you leave them — \`item\` (its ID),
  \`sticky\` (\`Storming.Element\`) and \`why\` (at most ${L.reviewKnowledge}). Never edit knowledge: people decide.${review.knowledge && review.knowledge.length > 0 ? RETIRE : ''}
Empty lists when there is nothing to say.

<review-${nonce}>
${blockJson({ review: data })}
</review-${nonce}>
`;
}

/**
 * The review's prompts: `continued` for the conversation that did the work (a warm agent), `fresh` for an agent that
 * starts afresh — the run's own prompt (`runPrompt`), said done, then the review.
 */
export function buildReviewPrompts(review: AgentReviewBody, runPrompt: string, nonce: string): { readonly continued: string; readonly fresh: string } {
    const text = reviewText(review, nonce);
    return {
        continued: text,
        fresh: `${runPrompt}
An earlier turn of this run already carried out the requests above: the files are as it left them. Do not carry them
out again.

${text}`,
    };
}
