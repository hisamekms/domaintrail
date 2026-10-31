import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { BaselineButton } from '../baseline-picker';
import { useT } from '../i18n';
import { SettingsDialog } from '../settings-dialog';
import type { Preferences } from './preferences';
import type { Connection } from './useViewSocket';

/** The header: the model's status and the connection, the baseline button and the settings. */
export function TopBar(props: {
    current: ViewPayload | null;
    connection: Connection;
    preferences: Preferences;
    baselineOpen: boolean;
    onBaselineToggle: (anchor: HTMLElement) => void;
}) {
    const { current, connection, preferences, baselineOpen, onBaselineToggle } = props;
    const { mode, setMode, themePreference, setThemePreference, theme, langPreference, setLangPreference, lang } = preferences;
    const t = useT();
    return (
        <header>
            <div className="brand">DomainTrail</div>
            <div className="status">
                {current && <span className={`pill pill-${current.status}`}>{t.status[current.status]}</span>}
                <span className="muted">
                    {current ? `${t.fileCount(current.files.length)} · v${current.version} · ${new Date(current.updatedAt).toLocaleTimeString(lang)}` : ''}
                </span>
                <span className={`conn conn-${connection}`} title={t.connectionTitle(t.connection[connection])} />
            </div>
            {current && <BaselineButton baseline={current.baseline} open={baselineOpen} onToggle={onBaselineToggle} />}
            <SettingsDialog
                mode={mode}
                onMode={setMode}
                themePreference={themePreference}
                theme={theme}
                onTheme={setThemePreference}
                langPreference={langPreference}
                lang={lang}
                onLang={setLangPreference}
            />
        </header>
    );
}
