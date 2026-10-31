import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeTooltip } from '@domaintrail/web/tooltip';

const WEB = join(import.meta.dir, '..', 'web');
const viewport = { width: 1000, height: 800 };
const size = { width: 120, height: 24 };

describe('tooltips', () => {
    test('are centred below the element', () => {
        expect(placeTooltip({ left: 400, top: 100, right: 440, bottom: 124 }, size, viewport)).toEqual({ left: 360, top: 130 });
    });

    test('go above the element when there is no room below', () => {
        expect(placeTooltip({ left: 400, top: 760, right: 440, bottom: 784 }, size, viewport)).toEqual({ left: 360, top: 730 });
    });

    test('stay inside the window at its edges', () => {
        expect(placeTooltip({ left: 0, top: 10, right: 24, bottom: 34 }, size, viewport).left).toBe(8);
        expect(placeTooltip({ left: 976, top: 10, right: 1000, bottom: 34 }, size, viewport).left).toBe(1000 - 8 - 120);
    });

    test('icon buttons use the app tooltip, not the native title', () => {
        const offending = readdirSync(WEB)
            .filter((f) => f.endsWith('.tsx'))
            .flatMap((f) =>
                // a button's opening tag (attributes may contain `=>` but not a bare `>` before the children)
                [...readFileSync(join(WEB, f), 'utf8').matchAll(/<button\b(?:=>|[^>])*>/g)]
                    .map((m) => m[0])
                    .filter((tag) => tag.includes('aria-label=') && /\stitle=/.test(tag))
                    .map((tag) => `${f}: ${tag.replace(/\s+/g, ' ')}`),
            );
        expect(offending).toEqual([]);
    });
});
