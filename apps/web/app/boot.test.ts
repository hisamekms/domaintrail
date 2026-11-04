// The page's boot (app/boot.ts): what the server wrote into the page for its first frame, read with a fallback.
import { describe, expect, test } from 'bun:test';
import { PAGE_BOOT_ID } from '@domaintrail/visualization/protocol';
import { parseBoot, readBoot } from './boot';

/** A document holding a boot block with `text` (none: no block). */
const page = (text?: string): Pick<Document, 'getElementById'> => ({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what readBoot reads of an element
    getElementById: (id: string) => (id === PAGE_BOOT_ID && text !== undefined ? ({ textContent: text } as HTMLElement) : null),
});

describe('the boot of the page', () => {
    test('reads the workspace’s name and the session’s mode from the block', () => {
        expect(readBoot(page('{"workspaceName":"shop","session":{"mode":"Solo"}}'))).toEqual({ workspaceName: 'shop', session: { mode: 'Solo' } });
        expect(readBoot(page('{"workspaceName":"shop"}'))).toEqual({ workspaceName: 'shop' });
        // as the server escapes it: `<` written as its JSON escape
        expect(readBoot(page('{"workspaceName":"a\\u003cb"}'))).toEqual({ workspaceName: 'a<b' });
    });

    test('falls back to nothing without a block, or a page, or with one that does not parse', () => {
        expect(readBoot(page())).toBeUndefined();
        expect(readBoot(undefined)).toBeUndefined();
        expect(readBoot(page('{"workspaceName":'))).toBeUndefined();
        expect(parseBoot('[]')).toBeUndefined();
        expect(parseBoot('')).toBeUndefined();
    });

    test('keeps only what is well-formed', () => {
        expect(parseBoot('{"workspaceName":42,"session":{"mode":"Party"}}')).toEqual({});
        expect(parseBoot('{"workspaceName":"","session":{"mode":"Collab"}}')).toEqual({ session: { mode: 'Collab' } });
    });
});
