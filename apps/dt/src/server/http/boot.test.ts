import { describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { PageBoot } from '@domaintrail/visualization/protocol';
import type { Assets } from './assets.js';
import { bootBlock, pageBoot, withBoot } from './boot.js';
import { createViewHttpServer } from './server.js';

const PAGE =
    '<!doctype html><html><head><title>DomainTrail</title><script type="module" src="./index.js"></script></head><body><div id="root"></div></body></html>';

/** The JSON of the boot block in `html`, parsed as the page parses it. */
const bootOf = (html: string): unknown => JSON.parse(/<script type="application\/json" id="dt-boot">(.*?)<\/script>/s.exec(html)?.[1] ?? 'null');

describe('the boot of the page', () => {
    test('the workspace’s name is the last folder of its root; the session’s mode only where a session serves the page', () => {
        expect(pageBoot('/work/shop')).toEqual({ workspaceName: 'shop' });
        expect(pageBoot('/work/shop/', 'Solo')).toEqual({ workspaceName: 'shop', session: { mode: 'Solo' } });
        expect(pageBoot('/work/shop', 'Collab')).toEqual({ workspaceName: 'shop', session: { mode: 'Collab' } });
    });

    test('is written at the end of the head, before the page’s module runs', () => {
        const html = withBoot(PAGE, { workspaceName: 'shop' });
        expect(html).toContain(
            '<script type="module" src="./index.js"></script><script type="application/json" id="dt-boot">{"workspaceName":"shop"}</script></head>',
        );
        expect(bootOf(html)).toEqual({ workspaceName: 'shop' });
        // a page without a head: at its start
        expect(withBoot('<div id="root"></div>', {}).startsWith('<script type="application/json" id="dt-boot">{}</script>')).toBe(true);
    });

    test('no value can close the block or open a comment: every < is escaped, and reads back as it was', () => {
        const boot: PageBoot = { workspaceName: '</script><script>alert(1)</script><!--' };
        const block = bootBlock(boot);
        const json = block.slice(block.indexOf('>') + 1, -'</script>'.length);
        expect(json).not.toContain('<');
        expect(json).toContain('\\u003c/script>\\u003cscript>');
        expect(bootOf(withBoot(PAGE, boot))).toEqual(boot);
    });
});

describe('the server writes the boot into the page', () => {
    const assets: Assets = new Map([
        ['/index.html', { type: 'text/html;charset=utf-8', body: Buffer.from(PAGE) }],
        ['/', { type: 'text/html;charset=utf-8', body: Buffer.from(PAGE) }],
        ['/index-abcd1234.js', { type: 'text/javascript;charset=utf-8', body: Buffer.from('const a = "</head>";') }],
    ]);

    const serve = async (boot: PageBoot | undefined, run: (url: string) => Promise<void>): Promise<void> => {
        const http = createViewHttpServer({ host: '127.0.0.1', api: new Map(), assets, upgrade: () => {}, ...(boot && { boot }) });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        try {
            await run(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
        } finally {
            await new Promise((resolve) => http.close(resolve));
        }
    };

    test('at / and /index.html; the other files as built', async () => {
        await serve({ workspaceName: 'shop', session: { mode: 'Solo' } }, async (url) => {
            for (const p of ['/', '/index.html']) {
                const res = await fetch(url + p);
                expect(res.headers.get('content-type')).toBe('text/html;charset=utf-8');
                expect(bootOf(await res.text())).toEqual({ workspaceName: 'shop', session: { mode: 'Solo' } });
            }
            expect(await (await fetch(`${url}/index-abcd1234.js`)).text()).toBe('const a = "</head>";');
        });
    });

    test('without a boot, the page as built', async () => {
        await serve(undefined, async (url) => {
            expect(await (await fetch(url)).text()).toBe(PAGE);
        });
    });
});
