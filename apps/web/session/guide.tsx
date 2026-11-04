// `/guide` (ガイド) in the chat (the plan's "ガイド"): the composer's button that runs it at once (nothing to
// type, no file changed), the compass by the AI's name on its answer, and the star by a command it suggests in `/`'s
// list. What decides them (shown or not, which commands) is `slash.ts`'s; these only draw them.
import { Compass, Star } from 'lucide-react';
import type { ReactElement } from 'react';
import type { StartCommandBody } from '@domaintrail/collaboration/protocol';
import { commandBody } from './outgoing';

/**
 * ガイド pressed: `/guide` started at once, its opening message the command's name in the UI language, with the
 * element selected and the view (what the AI reads to tell where the person is). The composer is left as it is.
 */
export async function startGuide(api: { startCommand(body: StartCommandBody): Promise<unknown> }, input: Omit<StartCommandBody, 'command'>): Promise<void> {
    await api.startCommand(commandBody({ ...input, command: 'guide' }));
}

/**
 * ガイド at the left end of the composer's bar: an action (the brand on a pale wash), its label dropped when the
 * bar is narrow (the CSS), the tooltip and the aria-label always. Disabled while a guide runs (`disabled`), or while this
 * page starts one (`busy`).
 */
export function GuideButton(props: {
    readonly state: 'ready' | 'disabled';
    readonly busy: boolean;
    readonly label: string;
    readonly onPress: () => void;
}): ReactElement {
    return (
        <button
            type="button"
            className="chat-guide"
            disabled={props.state === 'disabled' || props.busy}
            onClick={props.onPress}
            aria-label={props.label}
            data-tooltip={props.label}
        >
            <Compass size={14} aria-hidden />
            <span className="chat-guide-label">{props.label}</span>
        </button>
    );
}

/** The compass by the AI's name on a guide's card (ガイド). */
export function GuideMark({ label }: { readonly label: string }): ReactElement {
    return (
        <span className="chat-guide-mark" role="img" aria-label={label} data-tooltip={label}>
            <Compass size={13} aria-hidden />
        </span>
    );
}

/** The star by a command the latest guide suggests, in `/`'s list (ガイドのおすすめ). */
export function SuggestedMark({ label }: { readonly label: string }): ReactElement {
    return (
        <span className="chat-slash-suggested" role="img" aria-label={label} data-tooltip={label}>
            <Star size={12} aria-hidden />
        </span>
    );
}
