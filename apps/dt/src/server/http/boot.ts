// The facts the page needs in its first frame (`PageBoot`), written into the HTML the server serves: the page reads them
// synchronously at start, before any payload arrives, so that nothing it lays out moves when the payload comes.
import * as path from 'node:path';
import { PAGE_BOOT_ID, type PageBoot } from '@domaintrail/visualization/protocol';

/**
 * The boot of the page of the workspace at `root`: its name as the page shows it (the last folder of its root, as
 * `workspaceName` in apps/web/app/health.ts), and the session's mode when a session serves it.
 */
export function pageBoot(root: string, mode?: 'Solo' | 'Collab'): PageBoot {
    const name = path.basename(path.resolve(root));
    return { ...(name && { workspaceName: name }), ...(mode && { session: { mode } }) };
}

/**
 * The boot block: `boot` as JSON in a `<script type="application/json">`, which no browser runs (so a script policy
 * leaves it alone). Every `<` is written as its JSON escape (backslash, u003c), so that no value can close the element
 * or open a comment; JSON.parse reads it back as `<`.
 */
export function bootBlock(boot: PageBoot): string {
    const json = JSON.stringify(boot).replace(/</g, '\\u003c');
    return `<script type="application/json" id="${PAGE_BOOT_ID}">${json}</script>`;
}

/** `html` with the boot block at the end of its head (else at its start), before the page's module runs. */
export function withBoot(html: string, boot: PageBoot): string {
    const block = bootBlock(boot);
    const at = html.indexOf('</head>');
    return at < 0 ? block + html : `${html.slice(0, at)}${block}${html.slice(at)}`;
}
