// The size of the page's text (the settings' 文字の大きさ). The UI's sizes in styles.css are in rem, so they follow the
// root font size: the browser's default font size (16px unless the reader changed it) times the scale of the chosen
// size. 標準 leaves the root alone, so that at the browser's default the page is as it was in px. The canvas's
// drawing keeps its px sizes (its zoom scales it).

export type TextSize = 'small' | 'standard' | 'large' | 'xlarge';

export const TEXT_SIZES: readonly TextSize[] = ['small', 'standard', 'large', 'xlarge'];

/** localStorage key of the choice (JSON, like the other persisted settings; also read by index.html). */
export const TEXT_SIZE_KEY = 'domaintrail.textSize';

/** How much each size multiplies the browser's default font size. */
export const TEXT_SCALES: Readonly<Record<TextSize, number>> = { small: 0.9, standard: 1, large: 1.15, xlarge: 1.3 };

/** The root font size the sizes in styles.css were written against (px values / 16 = rem values). */
export const BASE_FONT_PX = 16;

export function isTextSize(value: unknown): value is TextSize {
    return typeof value === 'string' && (TEXT_SIZES as readonly string[]).includes(value);
}

/** The `font-size` of `<html>` for a size: a percentage of the browser's default ('' for 標準: the default itself). */
export function rootFontSize(size: TextSize): string {
    const scale = TEXT_SCALES[size];
    return scale === 1 ? '' : `${Math.round(scale * 1000) / 10}%`;
}

/** How much larger the UI is than at a 16px root: the browser's default and the chosen size together. */
export function uiScale(rootPx: number): number {
    return Number.isFinite(rootPx) && rootPx > 0 ? rootPx / BASE_FONT_PX : 1;
}

/** A pane's default size (px at a 16px root) at a UI scale, so that larger text does not wrap everything. */
export function scaledSize(base: number, scale: number): number {
    return Math.round(base * scale);
}

/** Applies the size to the page (the root font size). */
export function applyTextSize(size: TextSize): void {
    document.documentElement.style.fontSize = rootFontSize(size);
}

/** The UI scale of the page as shown (the root font size it resolves to). */
export function measuredUiScale(): number {
    if (typeof document === 'undefined') return 1;
    return uiScale(parseFloat(getComputedStyle(document.documentElement).fontSize));
}
