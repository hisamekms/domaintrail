// A suggested command's button (the guide's steps, the map without a goal): it puts `/` and the command's ID in the
// composer (`/`'s list opens on it): the person sends it, nothing runs by itself. Anyone may start any command; one of
// a kind already running is disabled.
import type { SuggestedCommandId } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { ComposerValue } from './mentions';
import { canStartCommand } from './slash';

/** The composer holding a command: `/` and its ID, nothing else (`/`'s list opens on it). */
export const commandComposerValue = (id: string): ComposerValue => ({ text: `/${id}`, chips: [], people: [] });

/** A step's command button: enabled when the command may start now (none of its kind running). */
export function commandButton(state: Pick<SessionStateBody, 'interviews' | 'slashCommands'>, id: SuggestedCommandId): 'enabled' | 'disabled' {
    return canStartCommand(state, id) ? 'enabled' : 'disabled';
}
