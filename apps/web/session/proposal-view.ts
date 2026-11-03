// A change proposal as its card shows it (ADR 0030, 変更案), without React: its targets as element references named in
// the display setting with their kind and where they are (`#注文` 集約・販売), the first three and how many more; which
// option is chosen (the facilitator's pick while it waits, else the AI's recommendation; once approved, the one
// approved with); and the how that stands for the proposal or an option (the facilitator's edit once approved with one).
import { contextOf } from '@domaintrail/modeling';
import { firstDeclarations } from '@domaintrail/storming';
import type { Messages } from '../i18n';
import { nameIn, resolve } from '../model-utils';
import type { ProposalJson } from './ai';
import { targetName, targetShortName, type ModelTarget, type NamingContext } from './targets';

type Content = ProposalJson['content'];
type Option = Content['options'][number];

/** The most targets shown of a proposal or an option; past them, 「ほか n」. */
export const SHOWN_TARGETS = 3;

/** How a target is shown: its own name, what it is and where (when it resolves), its whole name in the tooltip. */
export interface TargetLabel {
    readonly name: string;
    /** Its kind and where it is (`集約・販売`), when it resolves. */
    readonly detail?: string;
    /** Its whole name, when that says more than its own. */
    readonly path?: string;
    /** Whether it resolves now (a link); one that does not — not added yet, or gone — is plain text. */
    readonly resolved: boolean;
}

/** The names of kinds: `kinds` (`.dt`) and `esKinds` (`.dtes`) of the messages, and what a storming is called. */
export type KindNames = Pick<Messages, 'kinds' | 'esKinds' | 'inStorming'>;

/** The name of a context in the display setting. */
function contextName(naming: NamingContext, name: string): string {
    const ctx = naming.model ? contextOf(naming.model, name) : undefined;
    return nameIn(naming.mode, name, ctx?.label);
}

/**
 * A target of a proposal as its chip shows it; one that does not resolve by its identifier (`plainIdentifier`: of a
 * storming or a storming element, its own ID).
 */
export function targetLabel(t: ModelTarget, naming: NamingContext | undefined, kinds: KindNames): TargetLabel {
    const name = naming && targetShortName(t, naming);
    if (!naming || name === undefined) {
        const id =
            t.kind === 'DtElement'
                ? t.element
                : t.kind === 'DtesStorming'
                  ? t.storming
                  : t.kind === 'DtesElement'
                    ? t.local
                    : t.kind === 'DtesOccurrence'
                      ? t.eventName
                      : '';
        return { name: id, resolved: false };
    }
    const full = targetName(t, naming);
    const path = full !== undefined && full !== name ? { path: full } : {};
    const detail = ((): string | undefined => {
        if (t.kind === 'DtElement') {
            const r = naming.model ? resolve(naming.model, t.element) : undefined;
            if (r?.kind === 'element') return `${kinds.kinds[r.el.kind]}・${contextName(naming, r.el.context)}`;
            if (r?.kind === 'state' || r?.kind === 'command') return `${kinds.kinds[r.kind]}・${nameIn(naming.mode, r.agg.name, r.agg.label)}`;
            return undefined;
        }
        if (t.kind === 'DtesStorming') return kinds.inStorming;
        if (t.kind === 'DtesElement') {
            const view = naming.stormings.find((s) => s.id === t.storming);
            const declaration = view && firstDeclarations(view.storming).get(t.local);
            return view && declaration ? `${kinds.esKinds[declaration.kind]}・${nameIn(naming.mode, view.id, view.storming.label)}` : undefined;
        }
        return undefined;
    })();
    return { name, resolved: true, ...(detail && { detail }), ...path };
}

/** The targets that resolve now (none before the model is read): a candidate's chips leave out those to be added. */
export function existingTargets(targets: readonly ModelTarget[], naming: NamingContext | undefined, kinds: KindNames): readonly ModelTarget[] {
    return targets.filter((t) => targetLabel(t, naming, kinds).resolved);
}

/** The first `SHOWN_TARGETS` of some targets, and how many more there are. */
export function shownTargets<T>(targets: readonly T[]): { readonly shown: readonly T[]; readonly more: number } {
    return { shown: targets.slice(0, SHOWN_TARGETS), more: Math.max(0, targets.length - SHOWN_TARGETS) };
}

/** The option the AI recommends (its index; the first when none is marked), undefined without options. */
export function recommendedIndex(content: Content): number | undefined {
    if (content.options.length === 0) return undefined;
    return Math.max(
        0,
        content.options.findIndex((o) => o.recommended),
    );
}

/**
 * The option a proposal stands with: once approved, the one approved with; while open, the facilitator's pick when
 * there is one, else the AI's recommendation; undefined without options.
 */
export function chosenIndex(p: ProposalJson, picked: number | undefined): number | undefined {
    if (p.content.options.length === 0) return undefined;
    if (p.state === 'Approved') return p.option;
    return picked !== undefined && picked < p.content.options.length ? picked : recommendedIndex(p.content);
}

/** The how of an option: its own, else the proposal's. */
export const optionHow = (content: Content, option: Option): string => option.how ?? content.how;

/**
 * The how a proposal's card shows on top: the facilitator's edit once approved with one and without options (with
 * options the edit goes with the chosen option), else the proposal's.
 */
export function headHow(p: ProposalJson): string {
    return p.state === 'Approved' && p.editedHow && p.content.options.length === 0 ? p.editedHow : p.content.how;
}

/** The how an option of the card shows: the facilitator's edit when the proposal was approved with it, else its own (if any). */
export function shownOptionHow(p: ProposalJson, index: number): string | undefined {
    const option = p.content.options[index];
    if (p.state === 'Approved' && p.option === index && p.editedHow) return p.editedHow;
    return option?.how;
}

/** The how the facilitator edits for an option (or the proposal without options), before approving. */
export function editableHow(content: Content, option: number | undefined): string {
    const chosen = option === undefined ? undefined : content.options[option];
    return chosen ? optionHow(content, chosen) : content.how;
}

/** The label of the option an approved proposal was approved with, if it had options. */
export function approvedLabel(p: ProposalJson): string | undefined {
    return p.state === 'Approved' && p.option !== undefined ? p.content.options[p.option]?.label : undefined;
}
