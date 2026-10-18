import { Settings } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { Lang } from '../src/graph/ir';
import { LANG_NAMES, useT, type LangPreference } from './i18n';
import { useDismiss } from './layout';
import type { Theme, ThemePreference } from './theme';

const THEMES: ThemePreference[] = ['auto', 'light', 'dark'];
const LANG_PREFERENCES: LangPreference[] = ['auto', 'ja', 'en'];

/** Header menu for settings that are rarely changed (the language and the theme). */
export function SettingsMenu(props: {
    themePreference: ThemePreference;
    theme: Theme;
    onTheme: (t: ThemePreference) => void;
    langPreference: LangPreference;
    lang: Lang;
    onLang: (l: LangPreference) => void;
}) {
    const { themePreference, theme, onTheme, langPreference, lang, onLang } = props;
    const t = useT();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, useCallback(() => setOpen(false), []));

    return (
        <div className="settings-menu" ref={root}>
            <button className="icon-button" aria-haspopup="dialog" aria-expanded={open} aria-label={t.settings} title={t.settings} onClick={() => setOpen(!open)}>
                <Settings size={16} aria-hidden />
            </button>
            {open && (
                <div className="settings-menu-panel" role="dialog" aria-label={t.settings}>
                    <div className="settings-row">
                        <span className="settings-caption">{t.language}</span>
                        <div className="segmented small" role="group" aria-label={t.language} title={langPreference === 'auto' ? t.langAuto(LANG_NAMES[lang]) : undefined}>
                            {LANG_PREFERENCES.map((l) => (
                                <button key={l} className={langPreference === l ? 'active' : ''} aria-pressed={langPreference === l} onClick={() => onLang(l)}>
                                    {l === 'auto' ? t.themes.auto : LANG_NAMES[l]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="settings-row">
                        <span className="settings-caption">{t.theme}</span>
                        <div className="segmented small" role="group" aria-label={t.theme} title={themePreference === 'auto' ? t.themeAuto(t.themes[theme]) : undefined}>
                            {THEMES.map((th) => (
                                <button key={th} className={themePreference === th ? 'active' : ''} aria-pressed={themePreference === th} onClick={() => onTheme(th)}>
                                    {t.themes[th]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
