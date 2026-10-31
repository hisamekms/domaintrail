import { Settings, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DISPLAY_MODES, type DisplayMode, type Lang } from '@domaintrail/visualization/domain/graph/ir';
import { LANG_NAMES, useT, type LangPreference } from './i18n';
import type { Theme, ThemePreference } from './theme';

const THEMES: ThemePreference[] = ['auto', 'light', 'dark'];
const LANG_PREFERENCES: LangPreference[] = ['auto', 'ja', 'en'];

/** Header button opening a modal dialog with the settings (the names, the theme and the language). */
export function SettingsDialog(props: {
    mode: DisplayMode;
    onMode: (m: DisplayMode) => void;
    themePreference: ThemePreference;
    theme: Theme;
    onTheme: (t: ThemePreference) => void;
    langPreference: LangPreference;
    lang: Lang;
    onLang: (l: LangPreference) => void;
}) {
    const { mode, onMode, themePreference, theme, onTheme, langPreference, lang, onLang } = props;
    const t = useT();
    const [open, setOpen] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);

    // a modal <dialog> traps the focus, closes on Escape and makes the rest of the page inert
    useEffect(() => {
        const d = dialog.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        else if (!open && d.open) d.close();
    }, [open]);

    return (
        <div className="settings">
            <button
                className="icon-button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={t.settings}
                data-tooltip={t.settings}
                onClick={() => setOpen(true)}
            >
                <Settings size={16} aria-hidden />
            </button>
            <dialog
                ref={dialog}
                className="settings-dialog"
                aria-labelledby="settings-title"
                onClose={() => setOpen(false)}
                // a click on the backdrop lands on the dialog itself
                onClick={(e) => e.target === e.currentTarget && setOpen(false)}
            >
                <div className="settings-dialog-header">
                    <h2 id="settings-title">{t.settings}</h2>
                    <button className="icon-button" aria-label={t.closeSettings} data-tooltip={t.closeSettings} onClick={() => setOpen(false)}>
                        <X size={18} aria-hidden />
                    </button>
                </div>
                <div className="settings-dialog-body">
                    <SettingsRow id="settings-names" caption={t.nameDisplay} hint={t.nameDisplayHint}>
                        {DISPLAY_MODES.map((m) => (
                            <button key={m} className={mode === m ? 'active' : ''} aria-pressed={mode === m} onClick={() => onMode(m)}>
                                {t.modes[m]}
                            </button>
                        ))}
                    </SettingsRow>
                    <SettingsRow id="settings-theme" caption={t.theme} hint={themePreference === 'auto' ? t.themeAuto(t.themes[theme]) : t.themeHint}>
                        {THEMES.map((th) => (
                            <button
                                key={th}
                                className={themePreference === th ? 'active' : ''}
                                aria-pressed={themePreference === th}
                                onClick={() => onTheme(th)}
                            >
                                {t.themes[th]}
                            </button>
                        ))}
                    </SettingsRow>
                    <SettingsRow id="settings-lang" caption={t.language} hint={langPreference === 'auto' ? t.langAuto(LANG_NAMES[lang]) : t.langHint}>
                        {LANG_PREFERENCES.map((l) => (
                            <button key={l} className={langPreference === l ? 'active' : ''} aria-pressed={langPreference === l} onClick={() => onLang(l)}>
                                {l === 'auto' ? t.themes.auto : LANG_NAMES[l]}
                            </button>
                        ))}
                    </SettingsRow>
                </div>
            </dialog>
        </div>
    );
}

/** One setting: its caption and a hint on the left, the choices on the right. */
function SettingsRow(props: { id: string; caption: string; hint: string; children: ReactNode }) {
    return (
        <div className="settings-row">
            <div className="settings-text">
                <div className="settings-caption" id={props.id}>
                    {props.caption}
                </div>
                <div className="settings-hint">{props.hint}</div>
            </div>
            <div className="segmented" role="group" aria-labelledby={props.id}>
                {props.children}
            </div>
        </div>
    );
}
