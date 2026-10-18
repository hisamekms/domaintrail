import { Settings } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useDismiss } from './layout';
import type { Theme, ThemePreference } from './theme';

const THEME_LABEL: Record<ThemePreference, string> = { auto: '自動', light: 'ライト', dark: 'ダーク' };

/** Header menu for settings that are rarely changed (the theme). */
export function SettingsMenu(props: { themePreference: ThemePreference; theme: Theme; onTheme: (t: ThemePreference) => void }) {
    const { themePreference, theme, onTheme } = props;
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, useCallback(() => setOpen(false), []));

    return (
        <div className="settings-menu" ref={root}>
            <button className="icon-button" aria-haspopup="dialog" aria-expanded={open} aria-label="設定" title="設定" onClick={() => setOpen(!open)}>
                <Settings size={16} aria-hidden />
            </button>
            {open && (
                <div className="settings-menu-panel" role="dialog" aria-label="設定">
                    <div className="settings-row">
                        <span className="settings-caption">テーマ</span>
                        <div className="segmented small" role="group" aria-label="テーマ" title={themePreference === 'auto' ? `OS の設定に従う（いまは${THEME_LABEL[theme]}）` : undefined}>
                            {(Object.keys(THEME_LABEL) as ThemePreference[]).map((t) => (
                                <button key={t} className={themePreference === t ? 'active' : ''} aria-pressed={themePreference === t} onClick={() => onTheme(t)}>
                                    {THEME_LABEL[t]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
