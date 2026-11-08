import { useLayoutEffect, useState } from 'react';
import type { DisplayMode, Lang } from '@domaintrail/visualization';
import { LANG_KEY, useResolvedLang, type LangPreference } from '../i18n';
import { usePersistentState } from '../shared/layout';
import { THEME_KEY, useResolvedTheme, type Theme, type ThemePreference } from '../theme';
import { applyTextSize, isTextSize, measuredUiScale, TEXT_SIZE_KEY, type TextSize } from './text-size';

/** The settings of the settings dialog (remembered per browser), with the theme and language they resolve to. */
export interface Preferences {
    mode: DisplayMode;
    setMode: (m: DisplayMode) => void;
    themePreference: ThemePreference;
    setThemePreference: (t: ThemePreference) => void;
    theme: Theme;
    langPreference: LangPreference;
    setLangPreference: (l: LangPreference) => void;
    lang: Lang;
    textSize: TextSize;
    setTextSize: (s: TextSize) => void;
    /** How much larger the UI is than at a 16px root (the browser's default font size and the text size together). */
    uiScale: number;
}

/**
 * The name display with nothing saved under `domaintrail.nameDisplay`: the one saved under the former key (`ja`, `en`,
 * `both`), else ラベル.
 */
export function initialDisplayMode(former: string | null): DisplayMode {
    try {
        const old: unknown = JSON.parse(former ?? 'null');
        return old === 'en' ? 'name' : old === 'both' ? 'both' : 'label';
    } catch {
        return 'label';
    }
}

/** The display mode saved under its former key and values (日本語 / English / 両方), if any; ラベル otherwise. */
function savedDisplayMode(): DisplayMode {
    try {
        return initialDisplayMode(localStorage.getItem('domaintrail.displayMode'));
    } catch {
        return 'label';
    }
}

export function usePreferences(): Preferences {
    const [mode, setMode] = usePersistentState<DisplayMode>('domaintrail.nameDisplay', savedDisplayMode());
    const [themePreference, setThemePreference] = usePersistentState<ThemePreference>(THEME_KEY, 'auto');
    const theme = useResolvedTheme(themePreference);
    const [langPreference, setLangPreference] = usePersistentState<LangPreference>(LANG_KEY, 'auto');
    const lang = useResolvedLang(langPreference);
    const [savedTextSize, setTextSize] = usePersistentState<TextSize>(TEXT_SIZE_KEY, 'standard');
    const textSize = isTextSize(savedTextSize) ? savedTextSize : 'standard';
    const uiScale = useTextSize(textSize);
    return { mode, setMode, themePreference, setThemePreference, theme, langPreference, setLangPreference, lang, textSize, setTextSize, uiScale };
}

/** Applies the text size to the page (index.html applied the saved one before the app loaded) and gives the UI scale. */
function useTextSize(size: TextSize): number {
    const [scale, setScale] = useState(measuredUiScale);
    useLayoutEffect(() => {
        applyTextSize(size);
        setScale(measuredUiScale());
    }, [size]);
    return scale;
}
