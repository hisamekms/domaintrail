// 探す's way in: in the middle of the app bar, in both worlds, a button shaped like a search field — 🔍 探す and its key
// (⌘K on a Mac, Ctrl K elsewhere; none on a device without a keyboard). On a narrow bar, the magnifier alone.
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useT } from '../i18n';
import { paletteKeyText } from '../shared/palette';

export function SearchButton({ mac, onOpen }: { mac: boolean; onOpen: () => void }): ReactNode {
    const t = useT();
    const keys = paletteKeyText(mac);
    return (
        <button
            type="button"
            className="app-bar-find"
            aria-label={t.search.open}
            aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
            data-tooltip={`${t.search.open}（${keys}）`}
            onClick={onOpen}
        >
            <Search size={15} aria-hidden />
            <span className="app-bar-find-label">{t.search.open}</span>
            <kbd>{keys}</kbd>
        </button>
    );
}
