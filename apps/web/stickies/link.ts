// A link to an element (ADR 0033, リンクをコピー): the page's own URL with the element's selection ID in its fragment,
// `#select=es/<Storming>/<Local>`. The view state is the page's (kept per browser, not in the URL); a link only says what
// to select, and the page opens the world and the view that draw it (a storming's integrated canvas, at a level that
// draws the element), then drops the fragment. A fragment never reaches the server: it is never logged nor sent to Access.

const PARAM = 'select';

/** The link that opens the Live View at `base` (the page's URL) with `id` selected. */
export function elementLink(base: string, id: string): string {
    const url = new URL(base);
    url.hash = `${PARAM}=${encodeURIComponent(id)}`;
    return url.toString();
}

/** The selection ID a page's fragment names (`#select=…`), if any. */
export function linkedElement(hash: string): string | undefined {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const id = params.get(PARAM);
    return id !== null && id.length > 0 ? id : undefined;
}
