// Element references in the agent's reply (ADR 0026, appendix "Structured replies"): the agent names an element by its
// identifier, never by its label, as a token the page resolves and shows in the name display setting, as a link.
//
//   `.dt` element, state or command: `@{Sales.Order}`, `@{Sales.Order#Draft}`, `@{Sales.Order:confirm}` (its model ID,
//                                    the `element` of a `DtElement` target)
//   `.dtes` storming element:        `@{es:Returns/ReturnRequested}` (the storming's ID / the element's local ID, the
//                                    `storming` and `local` of a `DtesElement` target)
//   `.dtes` storming as a whole:     `@{es:Returns}` (the storming's ID, the `storming` of a `DtesStorming` target)
//
// A token is `@{`, an identifier without whitespace, braces or `@`, and `}`. A request body's mention is `@name[n]`
// (no braces), so the two never read as each other. `\@{` is a literal `@{` (the backslash is dropped). A token that
// does not read as a reference (whitespace in it, a path too long for `es:`) never shows its `@{` `}`: it is text, its
// identifier as written (of an `es:` one, its last segment). Pure: no React.
import type { ModelTarget, NamingContext } from './targets';
import { targetName, targetShortName } from './targets';

/** A piece of reply text: text as written, or an element reference (its target and the identifier written). */
export type ReplySegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'ref'; readonly target: ModelTarget; readonly id: string };

const TOKEN = /\\@\{|@\{([^\n{}@]{1,200})\}/gu;

/**
 * The target a token's identifier stands for: `es:<storming>/<local>`, `es:<storming>` or a `.dt` model ID; undefined
 * when malformed.
 */
function targetOf(id: string): ModelTarget | undefined {
    if (/\s/u.test(id)) return undefined;
    if (id.startsWith('es:')) {
        const m = /^es:([^/]+)(?:\/([^/]+))?$/.exec(id);
        if (!m) return undefined;
        return m[2] === undefined ? { kind: 'DtesStorming', storming: m[1] ?? '' } : { kind: 'DtesElement', storming: m[1] ?? '', local: m[2] };
    }
    return { kind: 'DtElement', element: id };
}

/** What a reference that does not resolve (or does not read as one) shows: its identifier, of an `es:` one its last segment. */
export function plainIdentifier(id: string): string {
    const t = id.trim();
    if (!t.startsWith('es:')) return t;
    return (
        t
            .slice(3)
            .split('/')
            .filter((s) => s.trim() !== '')
            .at(-1)
            ?.trim() ?? t
    );
}

/** Reply text as text and references, in order; text without tokens is one text segment (none for ''). */
export function parseReplyText(text: string): ReplySegment[] {
    const out: ReplySegment[] = [];
    let buffer = '';
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
        buffer += text.slice(last, m.index);
        last = m.index + m[0].length;
        const id = m[1];
        const target = id === undefined ? undefined : targetOf(id);
        if (id === undefined) buffer += '@{';
        else if (!target) buffer += plainIdentifier(id);
        else {
            if (buffer) out.push({ kind: 'text', text: buffer });
            buffer = '';
            out.push({ kind: 'ref', target, id });
        }
    }
    buffer += text.slice(last);
    if (buffer) out.push({ kind: 'text', text: buffer });
    return out;
}

/**
 * What a reference shows: its own name in the display setting when it resolves now (a state or a command without its
 * aggregate, a storming element without its storming, a storming by its title), with its whole name as `path` when that
 * says more; else its identifier (`plainIdentifier`: of a storming or a storming element, its own ID).
 */
export function referenceText(
    ref: Extract<ReplySegment, { kind: 'ref' }>,
    naming: NamingContext | undefined,
): { text: string; resolved: boolean; path?: string } {
    const name = naming && targetShortName(ref.target, naming);
    if (naming && name !== undefined) {
        const full = targetName(ref.target, naming);
        return { text: name, resolved: true, ...(full !== undefined && full !== name && { path: full }) };
    }
    return { text: plainIdentifier(ref.id), resolved: false };
}
