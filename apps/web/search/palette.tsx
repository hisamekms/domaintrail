// 探す's list as the palette draws it: each found item with its kind's mark (a sticky's paper, the model's dot), its
// text with what was typed marked, its kind and place, and its name at the right when only the name was found; the
// other world's item it is joined to by `ref` hung under it.
import type { DisplayMode } from '@domaintrail/visualization';
import type { Messages } from '../i18n';
import type { PaletteItem, PaletteSection } from '../shared/palette';
import { markRanges, shownText, type Findable, type ResultRow, type ResultSection } from './find';

/** A findable's kind as a small mark: a sticky's paper and edge, or the model's kind's colour. */
function KindMark({ item }: { item: Findable }) {
    if (item.world === 'storming') return <span className={`search-mark kind-es-${item.resolved ? 'resolvedHotspot' : item.kind}`} aria-hidden />;
    return <span className={`search-dot kind-${item.kind}`} aria-hidden />;
}

function itemOf(row: ResultRow, mode: DisplayMode, prefix: string, tag?: string): PaletteItem {
    const { item } = row;
    const shown = shownText(item, mode);
    return {
        id: `${prefix}:${item.key}`,
        label: shown.text,
        labelMarks: markRanges(shown.text, row.textMarks),
        detail: [item.kindName, item.place].filter(Boolean).join(' · '),
        ...(tag !== undefined && { tag }),
        ...(row.nameMarks.length > 0 && { code: { text: shown.name, marks: markRanges(shown.name, row.nameMarks) } }),
        mark: <KindMark item={item} />,
        title: item.name,
        ...(row.mates.length > 0 && { mates: row.mates.map((m) => itemOf(m, mode, `${prefix}:${item.key}`, 'ref')) }),
        run: item.run,
    };
}

/** The palette's sections of 探す's list. */
export function searchPaletteSections(sections: readonly ResultSection<PaletteItem>[], mode: DisplayMode, t: Messages): PaletteSection[] {
    return sections.map((s): PaletteSection => {
        if (s.kind === 'actions') return { id: 'actions', title: t.stickies.palette.actions, items: s.actions };
        if (s.kind === 'recent') return { id: 'recent', title: t.search.recent, items: s.rows.map((r) => itemOf(r, mode, 'recent')) };
        return { id: s.world, title: t.worlds[s.world], count: s.count, items: s.rows.map((r) => itemOf(r, mode, s.world)), more: s.more };
    });
}
