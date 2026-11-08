import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MESSAGES } from './i18n';
import { legendKindNames, LegendBody, STORMING_LEGEND_KINDS } from './legend';

describe('the storming legend key', () => {
    test('names every kind of note but the timeline, which is drawn as its arrows', () => {
        const kinds = Object.keys(MESSAGES.ja.esKinds).filter((k) => k !== 'timeline');
        expect(
            STORMING_LEGEND_KINDS.filter((k) => k !== 'resolvedHotspot')
                .map(String)
                .sort(),
        ).toEqual(kinds.sort());
    });

    test('has a resolved hotspot right after the hotspot, toned down and checked', () => {
        expect(STORMING_LEGEND_KINDS.indexOf('resolvedHotspot')).toBe(STORMING_LEGEND_KINDS.indexOf('hotspot') + 1);
        expect(legendKindNames(MESSAGES.ja).resolvedHotspot).toBe('解決済みのホットスポット');
        expect(legendKindNames(MESSAGES.en).resolvedHotspot).toBe('Resolved hotspot');
        const html = renderToStaticMarkup(createElement(LegendBody, { view: 'storming' }));
        expect(html).toMatch(/<span class="kind kind-es-resolvedHotspot"><svg class="dn-resolved-mark-chip"[^]*?<\/svg>解決済みのホットスポット<\/span>/);
        expect(renderToStaticMarkup(createElement(LegendBody, { view: 'structure' }))).not.toContain('resolvedHotspot');
    });
});
