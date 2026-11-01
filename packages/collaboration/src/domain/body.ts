// The tokens of a message's body (ADR 0026, appendix "Requests with several targets", and amendment "mentions of
// people"), read the same way by the page, the agent's prompt and the classifier. The body stays plain text:
//
//   `#name[n]`   an element: target n of the request (from 1). Written by the composer since `#` names elements.
//   `@name[n]`   the same, as bodies were written before (still read as an element: nothing is rewritten).
//   `@name[pN]`  a person: the N-th participant of the request's `mentions` (from 1).
//
// A Japanese IME's full-width `＃` and `＠` count as `#` and `@`. `name` is what the token was written with (no spaces,
// brackets, `#` or `@`); what it stands for is the number, so a page shows the name that the target or the person
// has now. A token whose number is not one of the request's is plain text.

/** Most people one request mentions (the `atMostTwentyMentions` invariant of Request). */
export const MAX_REQUEST_MENTIONS = 20;

/** Any token: the sign, the name, and either a target's number or `p` and a person's number. */
const TOKEN = /([#＃@＠])([^\s#＃@＠[\]]{1,80})\[(p?)([1-9]\d?)\]/gu;

/** A piece of a body: text, a mention of target `index`, or a mention of person `index` (both 0-based). */
export type BodySegment =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'element'; readonly name: string; readonly index: number }
    | { readonly kind: 'person'; readonly name: string; readonly index: number };

/** How many targets and people the request has: tokens with a number past them stay text. */
export interface BodyCounts {
    readonly targets: number;
    readonly people: number;
}

/** A token, read: `undefined` for a person token written with `#` (never written so). */
function tokenOf(
    sign: string,
    name: string,
    p: string,
    n: string,
): { readonly kind: 'element' | 'person'; readonly name: string; readonly index: number } | undefined {
    const person = p === 'p';
    if (person && (sign === '#' || sign === '＃')) return undefined;
    return { kind: person ? 'person' : 'element', name, index: Number(n) - 1 };
}

/** A body as text and mentions (elements and people). */
export function parseBody(text: string, counts: BodyCounts): BodySegment[] {
    const out: BodySegment[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
        const token = tokenOf(m[1], m[2], m[3], m[4]);
        if (!token || token.index >= (token.kind === 'element' ? counts.targets : counts.people)) continue;
        if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
        out.push(token);
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
}

/** Every token of a text, whatever the request has: what the composer keeps its targets and people in step with. */
export function tokensIn(text: string): { readonly kind: 'element' | 'person'; readonly name: string; readonly index: number }[] {
    return [...text.matchAll(TOKEN)].flatMap((m) => tokenOf(m[1], m[2], m[3], m[4]) ?? []);
}

/**
 * A text with each token's number mapped: `map` gives the new number (0-based), or `undefined` to turn the token into
 * its name as plain text. A token the map does not handle is given back as it is (`keep`).
 */
export function renumberTokens(text: string, kind: 'element' | 'person', map: (index: number) => number | undefined): string {
    return text.replace(TOKEN, (all: string, sign: string, name: string, p: string, n: string) => {
        const token = tokenOf(sign, name, p, n);
        if (!token || token.kind !== kind) return all;
        const to = map(token.index);
        return to === undefined ? name : `${sign}${name}[${p}${to + 1}]`;
    });
}

/**
 * A body as one reads it on one line: each element as `#name`, each person as `@name`, without their numbers (`bare`:
 * the names alone, as the classifier reads a message). With `counts`, only the request's tokens are read (the rest
 * stays as written); without, every token is.
 */
export function plainBody(text: string, counts?: BodyCounts, bare = false): string {
    return parseBody(text, counts ?? { targets: 99, people: 99 })
        .map((seg) => (seg.kind === 'text' ? seg.text : bare ? seg.name : seg.kind === 'element' ? `#${seg.name}` : `@${seg.name}`))
        .join('');
}

/** A name as a token writes it: no spaces, brackets, `#` or `@`, at most 80 characters. */
export const tokenName = (name: string): string => name.replace(/[\s#＃@＠[\]]/gu, '').slice(0, 80) || '?';

/** A body with each person mentioned as `@name`, its number dropped; the elements' tokens stay (the agent's prompt). */
export function peopleAsNames(text: string): string {
    return text.replace(TOKEN, (all: string, sign: string, name: string, p: string, n: string) =>
        tokenOf(sign, name, p, n)?.kind === 'person' ? `@${name}` : all,
    );
}
