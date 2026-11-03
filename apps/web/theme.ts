import { useEffect, useState } from 'react';
import type { DiagramCanvas } from './view/diagram';

/** The user's choice: follow the OS, or force light / dark. */
export type ThemePreference = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/** localStorage key of the preference (JSON, like the other persisted settings; also read by index.html). */
export const THEME_KEY = 'domaintrail.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The theme to show: the preference, or the OS setting for `auto` (kept up to date when the OS setting changes). */
export function useResolvedTheme(preference: ThemePreference): Theme {
    const [osDark, setOsDark] = useState(() => matchMedia(DARK_QUERY).matches);
    useEffect(() => {
        const query = matchMedia(DARK_QUERY);
        const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);
    return preference === 'auto' ? (osDark ? 'dark' : 'light') : preference;
}

/** Applies the theme to the page (CSS tokens on `<html data-theme>`) and to the canvas. */
export function applyTheme(theme: Theme, canvas: DiagramCanvas | null): void {
    document.documentElement.dataset.theme = theme;
    canvas?.setTheme(theme);
}
