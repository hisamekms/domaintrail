// `/hint` (ヒントをもらう) in the chat (the plan's "ヒントをもらう"): the composer's button that runs it at once (nothing to
// type, no file changed), the light bulb by the AI's name on its answer, and the star by a command it suggests in `/`'s
// list. What decides them (shown or not, which commands) is `slash.ts`'s; these only draw them.
import { Lightbulb, Star } from 'lucide-react';
import type { ReactElement } from 'react';
import type { StartCommandBody } from '@domaintrail/collaboration/protocol';
import { commandBody } from './outgoing';

/**
 * ヒントをもらう pressed: `/hint` started at once, its opening message the command's name in the UI language, with the
 * element selected and the view (what the AI reads to tell where the person is). The composer is left as it is.
 */
export async function startHint(api: { startCommand(body: StartCommandBody): Promise<unknown> }, input: Omit<StartCommandBody, 'command'>): Promise<void> {
    await api.startCommand(commandBody({ ...input, command: 'hint' }));
}

/**
 * ヒントをもらう at the left end of the composer's bar: an action (the brand on a pale wash), its label dropped when the
 * bar is narrow (the CSS), the tooltip and the aria-label always. Disabled while a hint runs (`disabled`), or while this
 * page starts one (`busy`).
 */
export function HintButton(props: {
    readonly state: 'ready' | 'disabled';
    readonly busy: boolean;
    readonly label: string;
    readonly onPress: () => void;
}): ReactElement {
    return (
        <button
            type="button"
            className="chat-hint"
            disabled={props.state === 'disabled' || props.busy}
            onClick={props.onPress}
            aria-label={props.label}
            data-tooltip={props.label}
        >
            <Lightbulb size={14} aria-hidden />
            <span className="chat-hint-label">{props.label}</span>
        </button>
    );
}

/** The light bulb by the AI's name on a hint's answer (ヒント). */
export function HintMark({ label }: { readonly label: string }): ReactElement {
    return (
        <span className="chat-hint-mark" role="img" aria-label={label} data-tooltip={label}>
            <Lightbulb size={13} aria-hidden />
        </span>
    );
}

/** The star by a command the latest hint suggests, in `/`'s list (ヒントのおすすめ). */
export function SuggestedMark({ label }: { readonly label: string }): ReactElement {
    return (
        <span className="chat-slash-suggested" role="img" aria-label={label} data-tooltip={label}>
            <Star size={12} aria-hidden />
        </span>
    );
}
