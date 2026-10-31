import type { DisplayMode, Lang } from '../../src/graph/ir';
import { LANG_KEY, useResolvedLang, type LangPreference } from '../i18n';
import { usePersistentState } from '../shared/layout';
import { THEME_KEY, useResolvedTheme, type Theme, type ThemePreference } from '../theme';

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
}

/** The display mode saved under its former key and values (日本語 / English / 両方), if any. */
function savedDisplayMode(): DisplayMode {
    try {
        const old: unknown = JSON.parse(localStorage.getItem('domaintrail.displayMode') ?? 'null');
        return old === 'ja' ? 'label' : old === 'en' ? 'name' : 'both';
    } catch {
        return 'both';
    }
}

export function usePreferences(): Preferences {
    const [mode, setMode] = usePersistentState<DisplayMode>('domaintrail.nameDisplay', savedDisplayMode());
    const [themePreference, setThemePreference] = usePersistentState<ThemePreference>(THEME_KEY, 'auto');
    const theme = useResolvedTheme(themePreference);
    const [langPreference, setLangPreference] = usePersistentState<LangPreference>(LANG_KEY, 'auto');
    const lang = useResolvedLang(langPreference);
    return { mode, setMode, themePreference, setThemePreference, theme, langPreference, setLangPreference, lang };
}
