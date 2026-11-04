// The page's text buttons, by what pressing them does (docs/ui-rules.md): the look comes from the kind alone, so a
// button that looks filled always decides, one in the code font always fills the composer, and so on. Icon-only
// buttons stay on `icon-button`; the ✓ of the journey's map is `MarkToggle`.
import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import { Check, CornerDownLeft } from 'lucide-react';

/**
 * What pressing a button does:
 * - `decide`: files or the session change now; the place's main decision, at most one per place (filled)
 * - `decide-sub`: a secondary decision next to it (grey outline)
 * - `send`: a message goes to the chat and the AI acts (pale brand wash)
 * - `insert`: a command goes into the composer only, the person sends it (brand outline, ↵, the code font)
 * - `see`: moves to a place, nothing changes (brand text, like a link)
 * - `open`: opens (or closes) a menu, the composer, a form or a panel (grey outline)
 * - `stop`: stops or cancels (grey outline, muted text)
 * - `danger`: refuses, or anything that cannot be undone (red outline)
 */
export type ActKind = 'decide' | 'decide-sub' | 'send' | 'insert' | 'see' | 'open' | 'stop' | 'danger';

export const ACT_KINDS: readonly ActKind[] = ['decide', 'decide-sub', 'send', 'insert', 'see', 'open', 'stop', 'danger'];

export type ActProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> & {
    readonly kind: ActKind;
    /** An icon before the text (an `insert` has its ↵ already). */
    readonly icon?: ReactNode;
    /** A layout hook of the place (its width, its position); never a look: that is the kind's. */
    readonly className?: string;
    readonly ref?: Ref<HTMLButtonElement>;
};

/** The classes of a kind: `act act-<kind>`, then the place's layout hook. */
export function actClass(kind: ActKind, className?: string): string {
    return `act act-${kind}${className ? ` ${className}` : ''}`;
}

/** A text button whose look says what pressing it does. */
export function Act({ kind, icon, className, type = 'button', children, ...rest }: ActProps): ReactElement {
    const lead = kind === 'insert' ? <CornerDownLeft size={12} aria-hidden /> : icon;
    return (
        <button {...rest} type={type} className={actClass(kind, className)}>
            {lead}
            {children}
        </button>
    );
}

/**
 * The ✓ a person sets on the journey's map where the files cannot tell (a decide: the journey file changes): a
 * checkbox with 済み / 済みにする. `readOnly`: the mark as it is, for whoever cannot set it.
 */
export function MarkToggle(props: {
    readonly on: boolean;
    /** The text by the box: 済み when on, 済みにする when off. */
    readonly text: string;
    readonly label: string;
    readonly tooltip?: string;
    readonly disabled?: boolean;
    readonly readOnly?: boolean;
    readonly onToggle?: () => void;
}): ReactElement {
    const box = (
        <span className="act-mark-box" aria-hidden>
            {props.on && <Check size={10} strokeWidth={3} />}
        </span>
    );
    const className = `act-mark${props.on ? ' on' : ''}`;
    if (props.readOnly)
        return (
            <span className={className} role="img" aria-label={props.label} {...(props.tooltip !== undefined && { 'data-tooltip': props.tooltip })}>
                {box}
                <span className="act-mark-text">{props.text}</span>
            </span>
        );
    return (
        <button
            type="button"
            className={className}
            aria-pressed={props.on}
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onToggle}
            {...(props.tooltip !== undefined && { 'data-tooltip': props.tooltip })}
        >
            {box}
            <span className="act-mark-text">{props.text}</span>
        </button>
    );
}
