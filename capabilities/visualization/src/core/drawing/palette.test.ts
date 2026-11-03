// The palette read from a stylesheet's text: the themes' blocks, `var()` chains, and the colour syntaxes styles.css uses.
import { describe, expect, test } from 'bun:test';
import { styleFonts, stylePalette, styleTokens, tokenColour } from './palette';
import { PALETTE_VARS } from './portable-svg';

const CSS = `
:root {
    --sans: 'Hiragino Sans', sans-serif;
    --mono: ui-monospace, monospace;
    /* a primitive */
    --p-white: #ffffff;
    --p-ink: #123;
    --surface: var(--p-white);
    --tint: color-mix(in srgb, var(--p-ink) 60%, transparent);
    --half: color-mix(in srgb, #000000 50%, #ffffff);
    --glass: rgba(255, 255, 255, 0.92);
    --sky: hsl(210, 20%, 98%);
}

.other {
    --surface: #ff0000;
}

:root[data-theme='dark'] {
    --surface: var(--p-ink);
}
`;

describe('the palette from a stylesheet', () => {
    const tokens = styleTokens(CSS);

    test('follows var() to a colour, the dark block over the light one, other rules ignored', () => {
        expect(tokenColour(tokens, 'light', '--surface')).toEqual({ hex: '#ffffff', alpha: 1 });
        expect(tokenColour(tokens, 'dark', '--surface')).toEqual({ hex: '#112233', alpha: 1 });
    });

    test('reads color-mix (premultiplied, as CSS mixes), rgba() and hsl()', () => {
        expect(tokenColour(tokens, 'light', '--tint')).toEqual({ hex: '#112233', alpha: 0.6 });
        expect(tokenColour(tokens, 'light', '--half')).toEqual({ hex: '#808080', alpha: 1 });
        expect(tokenColour(tokens, 'light', '--glass')).toEqual({ hex: '#ffffff', alpha: 0.92 });
        expect(tokenColour(tokens, 'light', '--sky')).toEqual({ hex: '#f9fafb', alpha: 1 });
    });

    test('a missing token is an error naming it', () => {
        expect(() => tokenColour(tokens, 'light', '--nothing')).toThrow('--nothing');
        expect(() => stylePalette(tokens, 'light')).toThrow(PALETTE_VARS[0]);
    });

    test('the font stacks', () => {
        expect(styleFonts(tokens)).toEqual({ sans: "'Hiragino Sans', sans-serif", mono: 'ui-monospace, monospace' });
    });
});
