// Values of Knowledge for the unit tests: made through the generated constructors, so that a typo fails loudly.
import { Knowledge } from './generated/index.js';

function known<T>(made: { ok: true; value: T } | { ok: false; error: unknown }): T {
    if (!made.ok) throw new Error(`invalid test value: ${JSON.stringify(made.error)}`);
    return made.value;
}

export const itemId = (v: string): Knowledge.KnowledgeItemId => known(Knowledge.makeKnowledgeItemId(v));
export const version = (v: number): Knowledge.ItemVersion => known(Knowledge.makeItemVersion(v));
export const sessionRef = (v: string): Knowledge.SessionRef => known(Knowledge.makeSessionRef(v));
export const userName = (v: string): Knowledge.UserName => known(Knowledge.makeUserName(v));
export const reason = (v: string): Knowledge.Reason => known(Knowledge.makeReason(v));

export const at = new Date('2026-11-05T09:00:00Z');
export const later = new Date('2026-11-05T09:05:00Z');

/** The extraction `number` of a session. */
export const extraction = (session: string, number: number): Knowledge.ExtractionRef => ({
    session: sessionRef(session),
    number: known(Knowledge.makeExtractionNumber(number)),
});

export const content = (text: string, origin: Knowledge.Origin = 'said', about: string[] = ['Ordering.CreateSpecification']): Knowledge.ItemContent => ({
    text: known(Knowledge.makeItemText(text)),
    labels: { when: 'as_is', kind: 'rule', origin },
    about: about.map((a) => known(Knowledge.makeStickyRef(a))),
});

/** A source: message `message` of a session. */
export const source = (session: string, message: string, quote = 'that is how we do it'): Knowledge.Source => ({
    session: sessionRef(session),
    message: known(Knowledge.makeMessageRef(message)),
    at,
    quote: known(Knowledge.makeQuote(quote)),
});

/** A live item made in a session (none: written by hand), at a version, with sources. */
export const liveItem = (
    id: string,
    over: { createdIn?: string; version?: number; sources?: Knowledge.Source[]; origin?: Knowledge.Origin; conflictsWith?: string[] } = {},
): Knowledge.LiveKnowledgeItem => ({
    state: 'Live',
    id: itemId(id),
    content: content(`the finding of ${id}`, over.origin),
    sources: over.sources ?? [source(over.createdIn ?? 's1', `m-${id}`)],
    version: version(over.version ?? 1),
    conflictsWith: (over.conflictsWith ?? []).map(itemId),
    ...(over.createdIn !== undefined && { createdIn: sessionRef(over.createdIn) }),
    createdAt: at,
    updatedAt: at,
});
