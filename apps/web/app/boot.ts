// What the server wrote into the page for its first frame (`PageBoot`, apps/dt/src/server/http/boot.ts): read once,
// synchronously, as the page starts. A page without it (served as built) starts as before and waits for the payload.
import { PAGE_BOOT_ID, type PageBoot } from '@domaintrail/visualization/protocol';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The boot in the block's text, keeping only what is well-formed; undefined without a block or when it does not parse. */
export function parseBoot(text: string | null | undefined): PageBoot | undefined {
    if (!text) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!isRecord(raw)) return undefined;
    const name = typeof raw.workspaceName === 'string' && raw.workspaceName !== '' ? raw.workspaceName : undefined;
    const mode = isRecord(raw.session) && (raw.session.mode === 'Solo' || raw.session.mode === 'Collab') ? raw.session.mode : undefined;
    return { ...(name !== undefined && { workspaceName: name }), ...(mode && { session: { mode } }) };
}

/** The page's boot block, read from `doc` (the page's document). */
export function readBoot(doc: Pick<Document, 'getElementById'> | undefined = typeof document === 'undefined' ? undefined : document): PageBoot | undefined {
    return parseBoot(doc?.getElementById(PAGE_BOOT_ID)?.textContent);
}
