// The buttons of dt's note after an interview's brief is confirmed (a message of the AI with a `journeyNote`): the next
// step's command (into the composer, as the guide card's command buttons), the place it shows (the source storming),
// and 「🧭 ジャーニーを開く」 (the journeys panel). The note's text is the message's body, shown as any AI reply.
import { useState, type ReactElement } from 'react';
import { Compass, Eye } from 'lucide-react';
import { suggestedCommandId } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useLang, useT } from '../i18n';
import { Act } from '../shared/act';
import { useChat } from './chat-context';
import { useTargetNaming } from './naming';
import { commandButton } from './next-steps';
import { targetLabel } from './proposal-view';
import { targetKey } from './targets';

type RequestJson = SessionStateBody['requests'][number];

/** An explicit edit request, so the ordinary Solo/Collab triage can route it as work after the person sends it. */
export function designLevelDraft(name: string, scope: 'flow' | 'all' | 'custom', lang: 'ja' | 'en'): string {
    if (lang === 'en')
        return scope === 'all'
            ? `Please edit the .dtes defining storming ${name} with a small provisional Design Level proposal for the whole storming, explain your assumptions, and ask what matters most.`
            : scope === 'flow'
              ? `Please edit the .dtes defining storming ${name} with a small provisional Design Level proposal for the [flow name] flow, explain your assumptions, and ask what matters most.`
              : `Please edit the .dtes defining storming ${name} with a small provisional Design Level proposal for [describe scope], explain your assumptions, and ask what matters most.`;
    return scope === 'all'
        ? `「${name}」全体に、根拠のある小さなデザインレベルの仮案を .dtes に描いてください。仮定を示し、重要な点を聞いてください。`
        : scope === 'flow'
          ? `「${name}」の［流れ名］に、根拠のある小さなデザインレベルの仮案を .dtes に描いてください。仮定を示し、重要な点を聞いてください。`
          : `「${name}」の［対象を記入］に、根拠のある小さなデザインレベルの仮案を .dtes に描いてください。仮定を示し、重要な点を聞いてください。`;
}

export function JourneyNoteActions({ request }: { readonly request: RequestJson }): ReactElement | null {
    const { tx, session, journeys, putCommand, putDraft, replies, onNavigate } = useChat();
    const all = useT();
    const lang = useLang();
    const [later, setLater] = useState(false);
    const naming = useTargetNaming();
    const note = request.journeyNote;
    if (!note) return null;
    const t = tx.chat.guide;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const id = note.command && suggestedCommandId(note.command);
    const button = id && live ? commandButton(session.state, id) : 'hidden';
    const draft = (scope: 'flow' | 'all' | 'custom'): void => {
        replies.startMessage(request.id);
        const name = note.journey.startsWith('es:') ? note.journey.slice(3) : note.journey;
        putDraft(designLevelDraft(name, scope, lang));
    };
    return (
        <p className="guide-actions journey-note-actions">
            {note.invitation && live && !later && (
                <>
                    <Act kind="insert" onClick={() => draft('flow')}>
                        {lang === 'en' ? 'One flow' : '一つの流れ'}
                    </Act>
                    <Act kind="insert" onClick={() => draft('all')}>
                        {lang === 'en' ? 'Whole storming' : '全体'}
                    </Act>
                    <Act kind="insert" onClick={() => draft('custom')}>
                        {lang === 'en' ? 'Choose scope' : '自由指定'}
                    </Act>
                    <Act kind="open" onClick={() => setLater(true)}>
                        {lang === 'en' ? 'Later' : 'あとで'}
                    </Act>
                </>
            )}
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
