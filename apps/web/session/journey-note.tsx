// The buttons of dt's note after an interview's brief is confirmed (a message of the AI with a `journeyNote`): the next
// step's command (into the composer, as the guide card's command buttons), the place it shows (the source storming),
// and 「🧭 ジャーニーを開く」 (the journeys panel). The note's text is the message's body, shown as any AI reply.
import type { ReactElement } from 'react';
import { Compass, Eye } from 'lucide-react';
import { suggestedCommandId } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useT } from '../i18n';
import { Act } from '../shared/act';
import { useChat } from './chat-context';
import { useTargetNaming } from './naming';
import { commandButton } from './next-steps';
import { targetLabel } from './proposal-view';
import { targetKey } from './targets';

type RequestJson = SessionStateBody['requests'][number];

export function JourneyNoteActions({ request }: { readonly request: RequestJson }): ReactElement | null {
    const { tx, session, journeys, putCommand, onNavigate } = useChat();
    const all = useT();
    const naming = useTargetNaming();
    const note = request.journeyNote;
    if (!note) return null;
    const t = tx.chat.guide;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const id = note.command && suggestedCommandId(note.command);
    const button = id && live ? commandButton(session.state, id) : 'hidden';
    return (
        <p className="guide-actions journey-note-actions">
            {id && button !== 'hidden' && (
                <Act
                    kind="insert"
                    disabled={button === 'disabled'}
                    data-tooltip={tx.chat.candidates.putCommand}
                    aria-label={`/${id}: ${tx.chat.candidates.putCommand}`}
                    onClick={() => putCommand(id)}
                >
                    /{id}
                </Act>
            )}
            {note.targets.map((p) => {
                const name = targetLabel(p, naming, all).name;
                return (
                    <Act key={targetKey(p)} kind="see" icon={<Eye size={12} aria-hidden />} aria-label={t.goTo(name)} onClick={() => onNavigate(p)}>
                        <span className="guide-go-name">{name}</span>
                    </Act>
                );
            })}
            <Act kind="open" icon={<Compass size={12} aria-hidden />} onClick={() => journeys.setOpen(true)}>
                {t.openJourneys}
            </Act>
        </p>
    );
}
