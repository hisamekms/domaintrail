// 「ソース一式をダウンロード」 (the menu's item for everyone in the session): the workspace's sources and its config file as
// one ZIP archive, made by the server from the files on disk (`GET /api/export/sources.zip`, behind the session's sign-in).

/** Where the server serves the archive. */
export const SOURCES_ZIP = '/api/export/sources.zip';

/** The file name a `Content-Disposition` gives: its `filename*` (UTF-8, percent-encoded), else its `filename`. */
export function attachmentName(disposition: string | null): string | undefined {
    if (!disposition) return undefined;
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded.trim());
        } catch {
            // not percent-encoded as it should be: the plain name, if any
        }
    }
    return /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(disposition)?.[1]?.trim();
}

/**
 * Downloads the archive: fetched first, so that a failure (no sources, signed out) is told in the page rather than as a
 * broken download, then saved under the name the server gives. Rejects with the server's message or the network's.
 */
export async function downloadSources(): Promise<void> {
    const res = await fetch(SOURCES_ZIP, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).trim() || res.statusText}`.trim());
    const url = URL.createObjectURL(await res.blob());
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = attachmentName(res.headers.get('content-disposition')) ?? 'sources.zip';
        document.body.append(a);
        a.click();
        a.remove();
    } finally {
        // the click has handed the blob to the download; revoked a little later, once the browser has read it
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
}
