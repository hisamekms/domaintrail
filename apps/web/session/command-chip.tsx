// A `/` command in the chat: its icon (the same in `/`'s list and on the chip), and its opening message shown as a chip
// in the person's row — the icon, the `/` ID in monospace and the name — instead of the name as plain text. Pressing
// the chip shows what the command does (the line `/`'s list shows beside its name). Which message is an opening is
// `slash.ts`'s (`commandOfOpening`, from the server's state); this only draws it.
import { BetweenHorizontalStart, GitBranch, Layers, Lightbulb, ScrollText, Sparkles, Tags, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { useDismiss } from '../shared/layout';
import type { CommandId } from './slash';

/** Each command's icon, in `/`'s list and on its chip. */
export const COMMAND_ICONS: Readonly<Record<CommandId, LucideIcon>> = {
    hint: Lightbulb,
    'es:start': Sparkles,
    'model:start': Sparkles,
    'es:exceptions': GitBranch,
    'es:gaps': BetweenHorizontalStart,
    'es:levels': Layers,
    'es:names': Tags,
    'es:recap': ScrollText,
};

/** A command's icon, in the brand colour. */
export function CommandIcon({ id, size = 13 }: { readonly id: CommandId; readonly size?: number }): ReactElement {
    const Icon = COMMAND_ICONS[id];
    return <Icon size={size} aria-hidden className="chat-slash-icon" />;
}

/**
 * A command's opening message: a pill with its icon, `/id` and name (`label`, its accessible name: コマンド /es:recap
 * ここまでのまとめ). Pressed, it shows the command's one-line description under it; a press outside or Escape hides it.
 */
export function CommandChip(props: { readonly id: CommandId; readonly name: string; readonly description: string; readonly label: string }): ReactElement {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    useDismiss(open, root, () => setOpen(false));
    return (
        <span className="chat-command" ref={root}>
            <button type="button" className="chat-command-chip" aria-label={props.label} aria-expanded={open} onClick={() => setOpen(!open)}>
                <CommandIcon id={props.id} />
                <code className="chat-command-id">/{props.id}</code>
                <span className="chat-command-name">{props.name}</span>
            </button>
            {open && (
                <span className="chat-command-about motion-pop" role="note">
                    {props.description}
                </span>
            )}
        </span>
    );
}
