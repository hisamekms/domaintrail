// A record in the chat (`domain/records.ts`): what a person did that leaves no other row (a goal changed, ✓ marks, a
// journey done, archived or brought back, the current journey chosen, a request and its outcome, an interview stopped,
// a brief rejected) or the journey file changed outside dt — a small muted row, centred like the session's start, its
// text in the page's language. A record at the end of an interview's thread hangs on the thread's line, after the
// avatar column, as a reply does.
import type { ReactElement } from 'react';
import { recordText } from '@domaintrail/collaboration';
import { useLang } from '../i18n';
import { time } from './bubble';
import { useChat } from './chat-context';
import type { RecordJson } from './stream';

/** A record's text as the page shows it: names as the chat names people now, in the page's language. */
export function recordLine(record: RecordJson, lang: 'ja' | 'en', nameOf: (id: string) => string): string {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record's JSON: its branded strings plain, the fields the text reads the same
    return recordText(record as unknown as Parameters<typeof recordText>[0], lang === 'en' ? 'En' : 'Ja', nameOf);
}

export function RecordRow({ record, hangs }: { readonly record: RecordJson; readonly hangs: boolean }): ReactElement {
    const { nameOf } = useChat();
    const lang = useLang();
    return (
        <div className={`chat-system chat-record${hangs ? ' hangs' : ''}`}>
            {hangs && <span className="chat-avatar-space" aria-hidden />}
            <span className="chat-system-text">{recordLine(record, lang, nameOf)}</span>
            <time className="chat-time" dateTime={record.revisedAt ?? record.at}>
                {time(record.revisedAt ?? record.at)}
            </time>
        </div>
    );
}
