// The fit of a storming's sticky note label (`@domaintrail/visualization`'s `fitLabel`), as the canvas uses it: it
// measures the label as the browser wraps it, and remembers what was decided until a font loads.
import type { LabelFit } from '@domaintrail/visualization';

export { fitLabel, fontSizes, NOTE_KINDS, type LabelFit } from '@domaintrail/visualization';

/** At most this many fits are remembered; the oldest go first. */
const MAX_REMEMBERED = 2000;
const remembered = new Map<string, LabelFit>();

/** The key of a fit: what changes it (the label, the note's size and text scale, and the fonts loaded so far). */
export const fitKey = (label: string, w: number, h: number, scale: number, fonts: number): string => `${fonts}|${scale}|${w}x${h}|${label}`;

export const rememberedFit = (key: string): LabelFit | undefined => remembered.get(key);

/** Remembers the fit of `key`. */
export function rememberFit(key: string, fit: LabelFit): void {
    if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
    remembered.set(key, fit);
}

/** How many times fonts have finished loading: a font loaded since a label was measured changes how it wraps. */
let fontLoads = 0;
const fontListeners = new Set<() => void>();
let listening = false;

/** Subscribes to fonts finishing loading (`useSyncExternalStore`), with one listener on `document.fonts` for all. */
export function subscribeFonts(onChange: () => void): () => void {
    if (!listening && typeof document !== 'undefined' && document.fonts) {
        listening = true;
        document.fonts.addEventListener('loadingdone', () => {
            fontLoads++;
            for (const listener of fontListeners) listener();
        });
    }
    fontListeners.add(onChange);
    return () => {
        fontListeners.delete(onChange);
    };
}

export const fontLoadCount = (): number => fontLoads;
