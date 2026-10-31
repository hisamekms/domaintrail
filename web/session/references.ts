// Element references in the agent's reply (ADR 0026, appendix "Structured replies"): the agent names an element by its
// identifier, never by its label, as a token the page resolves and shows in the name display setting, as a link.
//
//   `.dt` element, state or command: `@{Sales.Order}`, `@{Sales.Order#Draft}`, `@{Sales.Order:confirm}` (its model ID,
//                                    the `element` of a `DtElement` target)
//   `.dtes` storming element:        `@{es:Returns/ReturnRequested}` (the storming's ID / the element's local ID, the
//                                    `storming` and `local` of a `DtesElement` target)
//
// A token is `@{`, an identifier without whitespace, braces or `@`, and `}`. A request body's mention is `@name[n]`
// (no braces), so the two never read as each other. `\@{` is a literal `@{` (the backslash is dropped). Pure: no React.
import type { ModelTarget, NamingContext } from './targets';
import { targetName } from './targets';

/** A piece of reply text: text as written, or an element reference (its target and the identifier written). */
export type ReplySegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'ref'; readonly target: ModelTarget; readonly id: string };

const TOKEN = /\\@\{|@\{([^\s{}@]{1,200})\}/gu;

/** The target a token's identifier stands for: `es:<storming>/<local>` or a `.dt` model ID; undefined when malformed. */
function targetOf(id: string): ModelTarget | undefined {
    if (id.startsWith('es:')) {
        const m = /^es:([^/]+)\/([^/]+)$/.exec(id);
        return m ? { kind: 'DtesElement', storming: m[1] ?? '', local: m[2] ?? '' } : undefined;
    }
    return { kind: 'DtElement', element: id };
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
        else if (!target) buffer += m[0];
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

/** What a reference shows: its name in the display setting when it resolves now, else its identifier (no `es:`). */
export function referenceText(ref: Extract<ReplySegment, { kind: 'ref' }>, naming: NamingContext | undefined): { text: string; resolved: boolean } {
    const name = naming && targetName(ref.target, naming);
    if (name !== undefined) return { text: name, resolved: true };
    return { text: ref.target.kind === 'DtesElement' ? `${ref.target.storming}/${ref.target.local}` : ref.id, resolved: false };
}
