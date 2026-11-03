// Change proposals (ADR 0030, decision 4; the plan's "Stage 5"): a participant's change request, written up by the
// read-only answerer as the model elements to change and how, in a line or two, for the facilitator to approve (as is
// or with the how edited), reject (with a note) or for its requester to withdraw while it waits. When the answerer is
// unsure (the scope, most often), the proposal carries two or three options, one of them its recommendation; the
// facilitator picks one when approving. Approved together, proposals are one run. The text is the AI's: untrusted,
// validated against the limits below before it is kept, and shown as plain text.
//
// Targets are element references as the chat writes them (`@{Sales.Order}`, `@{es:Returns/ReturnRequested}`, a whole
// storming `@{es:Returns}`). One that
// is malformed (whitespace, braces, a path or a file name) is dropped; one that is well formed but names nothing yet
// is kept, since a proposal may add the element it names — the page shows it unlinked until it resolves.
import { Collaboration, decide, err, ok, type Result } from '../generated/index.js';

/** The limits of a proposal (characters, or items): change one here and every side follows. */
export const PROPOSAL_LIMITS = {
    /** How, as the AI writes it: a line or two. */
    how: 300,
    /** How, as the facilitator edits it before approving. */
    editedHow: 2000,
    /** An option's label. */
    label: 60,
    /** Targets of the proposal, or of one option (more are dropped). */
    targets: 50,
    /** Options (more are dropped, the recommended one kept). */
    options: 3,
    /** An element reference's identifier (as `@{…}` of the chat). */
    reference: 200,
    /** The facilitator's note to the requester when rejecting. */
    note: 500,
} as const;

/** An option of a proposal as the answerer sends it. */
export interface ProposalOptionData {
    readonly label: string;
    /** Element references (`@{Sales.Order}`, or the identifier alone). */
    readonly targets: readonly string[];
    readonly how?: string;
    readonly recommended?: boolean;
}

/** A proposal as the answerer sends it: element references, how in a line or two, options when unsure. */
export interface ProposalData {
    readonly targets: readonly string[];
    readonly how: string;
    readonly options?: readonly ProposalOptionData[];
}

/** Why a proposal's text was refused: where in it, and what is wrong. */
export interface ProposalProblem {
    readonly path: string;
    readonly message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `s` has a control character other than tabs and line breaks. */
function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const n = s.charCodeAt(i);
        if (n !== 0x09 && n !== 0x0a && n !== 0x0d && (n < 0x20 || (n >= 0x7f && n <= 0x9f))) return true;
    }
    return false;
}

/** Only `keys`: the schema's `additionalProperties: false`. */
function extra(v: Record<string, unknown>, keys: readonly string[], path: string): ProposalProblem | undefined {
    const k = Object.keys(v).find((x) => !keys.includes(x));
    return k === undefined ? undefined : { path: `${path}.${k}`, message: 'Unknown field.' };
}

/** A proposal's text: a non-blank string (trimmed) within `max`, without control characters. */
export function readProposalText(v: unknown, path: string, max: number): Result<Collaboration.ProposalText, ProposalProblem> {
    if (typeof v !== 'string' || !v.trim()) return err({ path, message: 'Expected a non-empty string.' });
    const t = v.trim();
    if (t.length > max) return err({ path, message: `At most ${max} characters.` });
    if (hasControl(t)) return err({ path, message: 'No control characters.' });
    const made = Collaboration.makeProposalText(t);
    return made.ok ? ok(made.value) : err({ path, message: 'Not a proposal text.' });
}

/** An identifier of a reference: no whitespace, braces, `@` or backslash. */
const IDENTIFIER = /^[^\s{}@\\]+$/u;

/**
 * The model element an element reference names: `@{Sales.Order}` (or `Sales.Order`; states and commands as
 * `Sales.Order#Draft`, `Sales.Order:confirm`) a `.dt` element, `@{es:Returns/ReturnRequested}` a storming element,
 * `@{es:Returns}` a whole storming; undefined when it is malformed — a path (`/` outside `es:`, or more than one in it),
 * a file (`.dt`, `.dtes`), whitespace or braces.
 */
export function parseElementReference(ref: string): Collaboration.ModelTarget | undefined {
    const t = ref.trim();
    const id = t.startsWith('@{') && t.endsWith('}') ? t.slice(2, -1) : t;
    if (!id || id.length > PROPOSAL_LIMITS.reference || !IDENTIFIER.test(id)) return undefined;
    if (id.startsWith('es:')) {
        const m = /^es:([^/]+)(?:\/([^/]+))?$/u.exec(id);
        const storming = m && Collaboration.makeStormingName(m[1] ?? '');
        if (!storming?.ok) return undefined;
        if (m?.[2] === undefined) return { kind: 'DtesStorming', storming: storming.value };
        const local = Collaboration.makeStormingLocalName(m[2]);
        return local.ok ? { kind: 'DtesElement', storming: storming.value, local: local.value } : undefined;
    }
    if (id.includes('/') || /\.dtes?$/iu.test(id)) return undefined;
    const element = Collaboration.makeElementName(id);
    return element.ok ? { kind: 'DtElement', element: element.value } : undefined;
}

/** A target, branded or as JSON gives it. */
type TargetLike =
    | { readonly kind: 'Workspace' }
    | { readonly kind: 'DtElement'; readonly element: string }
    | { readonly kind: 'DtesStorming'; readonly storming: string }
    | { readonly kind: 'DtesElement'; readonly storming: string; readonly local: string }
    | { readonly kind: 'DtesOccurrence'; readonly storming: string; readonly eventName: string };

/**
 * A target as an element reference (`@{Sales.Order}`, `@{es:Returns/ReturnRequested}`, `@{es:Returns}`), as the AI and
 * the chat write it.
 */
export function elementReference(t: TargetLike): string {
    switch (t.kind) {
        case 'DtElement':
            return `@{${t.element}}`;
        case 'DtesStorming':
            return `@{es:${t.storming}}`;
        case 'DtesElement':
            return `@{es:${t.storming}/${t.local}}`;
        case 'DtesOccurrence':
            return `@{es:${t.storming}/${t.eventName}}`;
        case 'Workspace':
            return 'the workspace';
    }
}

/**
 * Element references as targets: malformed ones dropped, each once, at most `max` (`PROPOSAL_LIMITS.targets`; the rest
 * dropped). Only a value that is not a list of strings is refused. The `/` commands' candidates read theirs the same.
 */
export function readTargets(v: unknown, path: string, max: number = PROPOSAL_LIMITS.targets): Result<Collaboration.ModelTarget[], ProposalProblem> {
    if (!Array.isArray(v)) return err({ path, message: 'Expected a list of element references.' });
    const out: Collaboration.ModelTarget[] = [];
    const seen = new Set<string>();
    for (const [i, ref] of v.entries()) {
        if (typeof ref !== 'string') return err({ path: `${path}[${i}]`, message: 'Expected an element reference.' });
        const t = parseElementReference(ref);
        if (!t || seen.has(elementReference(t))) continue;
        seen.add(elementReference(t));
        out.push(t);
    }
    return ok(out.slice(0, max));
}

/** One option: a label, its targets, its own how if any, whether recommended. */
function readOption(raw: unknown, path: string): Result<Collaboration.ProposalOption, ProposalProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, ['label', 'targets', 'how', 'recommended'], path);
    if (unknown) return err(unknown);
    const label = readProposalText(raw.label, `${path}.label`, PROPOSAL_LIMITS.label);
    if (!label.ok) return label;
    const made = Collaboration.makeProposalLabel(label.value);
    if (!made.ok) return err({ path: `${path}.label`, message: 'Not a label.' });
    const targets = readTargets(raw.targets ?? [], `${path}.targets`);
    if (!targets.ok) return targets;
    const how = raw.how === undefined ? undefined : readProposalText(raw.how, `${path}.how`, PROPOSAL_LIMITS.how);
    if (how && !how.ok) return how;
    if (raw.recommended !== undefined && typeof raw.recommended !== 'boolean') return err({ path: `${path}.recommended`, message: 'Expected a boolean.' });
    return ok({ label: made.value, targets: targets.value, ...(how && { how: how.value }), recommended: raw.recommended === true });
}

/**
 * The options as kept: exactly one recommended (the first marked one, else the first), at most
 * `PROPOSAL_LIMITS.options` (the recommended one and the first others, in their order).
 */
function clampOptions(options: readonly Collaboration.ProposalOption[]): Collaboration.ProposalOption[] {
    const recommended = Math.max(
        0,
        options.findIndex((o) => o.recommended),
    );
    const kept = new Set([recommended]);
    for (let i = 0; i < options.length && kept.size < PROPOSAL_LIMITS.options; i++) kept.add(i);
    return options.flatMap((o, i) => (kept.has(i) ? [{ ...o, recommended: i === recommended }] : []));
}

/**
 * A proposal validated: `{ targets, how, options? }` — targets as element references (malformed ones dropped), how a
 * non-blank string (trimmed) within its limit, without control characters, and nothing else. The options are clamped
 * rather than refused: at most three, exactly one recommended; a single option is no choice, and becomes the proposal
 * (its targets, when it has any, and its how, when it has one).
 */
export function readProposal(raw: unknown, path = 'proposal'): Result<Collaboration.ProposalContent, ProposalProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, ['targets', 'how', 'options'], path);
    if (unknown) return err(unknown);
    const targets = readTargets(raw.targets ?? [], `${path}.targets`);
    if (!targets.ok) return targets;
    const how = readProposalText(raw.how, `${path}.how`, PROPOSAL_LIMITS.how);
    if (!how.ok) return how;
    const rawOptions = raw.options ?? [];
    if (!Array.isArray(rawOptions)) return err({ path: `${path}.options`, message: 'Expected a list of options.' });
    const options: Collaboration.ProposalOption[] = [];
    for (const [i, o] of rawOptions.entries()) {
        const option = readOption(o, `${path}.options[${i}]`);
        if (!option.ok) return option;
        options.push(option.value);
    }
    const [only] = options;
    if (options.length === 1 && only) return ok({ targets: only.targets.length > 0 ? only.targets : targets.value, how: only.how ?? how.value, options: [] });
    return ok({ targets: targets.value, how: how.value, options: clampOptions(options) });
}

/** A proposal's content, branded or as JSON gives it. */
interface ContentLike {
    readonly targets: readonly TargetLike[];
    readonly how: string;
    readonly options: readonly { readonly label: string; readonly targets: readonly TargetLike[]; readonly how?: string; readonly recommended: boolean }[];
}

/** A proposal as the answerer sends it (`readProposal` reads it back the same), and as the agents are shown one. */
export function proposalData(c: ContentLike): ProposalData {
    return {
        targets: c.targets.map(elementReference),
        how: c.how,
        ...(c.options.length > 0 && {
            options: c.options.map((o) => ({
                label: o.label,
                targets: o.targets.map(elementReference),
                ...(o.how !== undefined && { how: o.how }),
                recommended: o.recommended,
            })),
        }),
    };
}

/** The JSON schema of a proposal (the answerer's `{ kind: 'proposal', proposal }`), from the limits. */
export function proposalJsonSchema(): Record<string, unknown> {
    const str = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
    // `@{` and `}` around an identifier
    const targets = { type: 'array', items: str(PROPOSAL_LIMITS.reference + 3), maxItems: PROPOSAL_LIMITS.targets };
    return {
        type: 'object',
        properties: {
            targets,
            how: str(PROPOSAL_LIMITS.how),
            options: {
                type: 'array',
                maxItems: PROPOSAL_LIMITS.options,
                items: {
                    type: 'object',
                    properties: { label: str(PROPOSAL_LIMITS.label), targets, how: str(PROPOSAL_LIMITS.how), recommended: { type: 'boolean' } },
                    required: ['label', 'targets'],
                    additionalProperties: false,
                },
            },
        },
        required: ['targets', 'how'],
        additionalProperties: false,
    };
}

/** The option a proposal recommends, by its index; undefined without options. */
export function recommendedOption(content: Collaboration.ProposalContent): Collaboration.ProposalOptionIndex | undefined {
    if (content.options.length === 0) return undefined;
    const made = Collaboration.makeProposalOptionIndex(
        Math.max(
            0,
            content.options.findIndex((o) => o.recommended),
        ),
    );
    return made.ok ? made.value : undefined;
}

/** Whether exactly one option is recommended when there are options (`ProposalContent.oneRecommended`). */
export const oneRecommended = (content: Collaboration.ProposalContent): boolean =>
    content.options.length === 0 || content.options.filter((o) => o.recommended).length === 1;

/**
 * What a proposal asks of the run with an option chosen (when it has options) and the how the facilitator edited (if
 * any): the option's label, its targets (the proposal's when it has none), the edited how, else the option's, else the
 * proposal's. Undefined when the option is not one of the proposal's, or none is chosen of a proposal with options.
 */
export function instructionOf(
    content: Collaboration.ProposalContent,
    option: number | undefined,
    editedHow: Collaboration.ProposalText | undefined,
): Collaboration.ProposalInstruction | undefined {
    if (option === undefined) return content.options.length > 0 ? undefined : { targets: content.targets, how: editedHow ?? content.how };
    const chosen = content.options[option];
    if (!chosen) return undefined;
    return {
        label: chosen.label,
        targets: chosen.targets.length > 0 ? chosen.targets : content.targets,
        how: editedHow ?? chosen.how ?? content.how,
    };
}

/** What an approved proposal asks of the run: its chosen option, with the how the facilitator edited if any. */
export function approvedInstruction(proposal: Collaboration.ApprovedChangeProposal): Collaboration.ProposalInstruction {
    // `approve` checked the option against the proposal's
    return (
        instructionOf(proposal.content, proposal.option, proposal.editedHow) ?? {
            targets: proposal.content.targets,
            how: proposal.editedHow ?? proposal.content.how,
        }
    );
}

export const proposalCommands: Collaboration.ChangeProposalCommands = {
    propose: decide<Collaboration.ProposeChangeProposalDecision>(Collaboration.ChangeProposalShape, (params) => {
        const { id, session, request, requestedBy, content, proposedAt } = params;
        // the triage without its evidence: the aggregate stores the base type
        const triage: Collaboration.TriageId = params.triage;
        return ok({
            Open: {
                set: { id, session, triage, request, requestedBy, content, proposedAt },
                events: { ChangeProposed: { type: 'ChangeProposed', proposalId: id, session, triage, request, requestedBy, content, proposedAt } },
            },
        });
    }),

    approve: decide<Collaboration.ApproveChangeProposalDecision>(Collaboration.ChangeProposalShape, {
        Open: (proposal, params) => {
            const failed = Collaboration.checkApproveChangeProposalRequires(proposal, params);
            if (failed === 'facilitatorApproves') return err({ type: 'FacilitatorOnly' });
            if (failed === 'optionOfProposal') return err({ type: 'NoSuchOption' });
            const { approvedBy, option, editedHow, run, approvedAt } = params;
            return ok({
                Approved: {
                    set: { approvedBy, approvedAt, option, editedHow, run },
                    events: {
                        ProposalApproved: {
                            type: 'ProposalApproved',
                            proposalId: proposal.id,
                            approvedBy,
                            ...(option !== undefined && { option }),
                            ...(editedHow && { editedHow }),
                            run,
                            approvedAt,
                        },
                    },
                },
            });
        },
    }),

    reject: decide<Collaboration.RejectChangeProposalDecision>(Collaboration.ChangeProposalShape, {
        Open: (proposal, params) => {
            if (Collaboration.checkRejectChangeProposalRequires(proposal, params) === 'facilitatorRejects') return err({ type: 'FacilitatorOnly' });
            const { rejectedBy, note, rejectedAt } = params;
            return ok({
                Rejected: {
                    set: { rejectedBy, rejectedAt, note },
                    events: { ProposalRejected: { type: 'ProposalRejected', proposalId: proposal.id, rejectedBy, ...(note && { note }), rejectedAt } },
                },
            });
        },
    }),

    withdraw: decide<Collaboration.WithdrawChangeProposalDecision>(Collaboration.ChangeProposalShape, {
        Open: (proposal, params) => {
            if (Collaboration.checkWithdrawChangeProposalRequires(proposal, params) === 'requesterWithdraws') return err({ type: 'NotTheRequester' });
            const { withdrawnBy, withdrawnAt } = params;
            return ok({
                Withdrawn: {
                    set: { withdrawnAt },
                    events: { ProposalWithdrawn: { type: 'ProposalWithdrawn', proposalId: proposal.id, withdrawnBy, withdrawnAt } },
                },
            });
        },
    }),
};
