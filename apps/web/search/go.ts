// Going to an item of the domain model found by 探す (`modelDestination`), through the reader's own moves — the
// navigation and the settings the workspace hands out — so that it stops following, as any move of the reader does
// (`view/follow.ts`). A command and a state switch to the domain model too, there only (`openBest` opens their
// detail and leaves the view as it is).
import type { InspectorTab } from '../inspector';
import type { NavigationMoves, SettingsMoves } from '../view/follow';
import type { ModelDestination } from './reveal';

/** What going to an item of the model moves. */
export interface ModelMoves {
    readonly nav: Pick<NavigationMoves, 'setView' | 'select'>;
    readonly settings: Pick<SettingsMoves, 'setStructureLevel' | 'setStructureContexts'>;
    /** Clears the catalog's filter. */
    readonly clearCatalogFilter: () => void;
    readonly openInspector: (tab: InspectorTab) => void;
    /** Selects the item of `id` on the canvas once it is drawn, then runs `then`. */
    readonly show: (id: string, then: () => void) => void;
}

export function goToModel(dest: ModelDestination, moves: ModelMoves): void {
    const { place } = dest;
    const { nav } = moves;
    switch (place.view) {
        case 'structure':
            if (place.level !== undefined) moves.settings.setStructureLevel(place.level);
            if (place.contexts !== undefined) moves.settings.setStructureContexts(place.contexts === null ? null : [...place.contexts]);
            nav.setView({ kind: 'structure' });
            nav.select(dest.select, { highlight: false });
            // a command's or a state's aggregate selected on the canvas (which selects it), then what was found again
            moves.show(place.show, () => {
                if (place.show !== dest.select) nav.select(dest.select, { highlight: false });
            });
            break;
        case 'contextMap':
            nav.setView({ kind: 'contextMap' });
            nav.select(dest.select, { highlight: false });
            moves.show(dest.select, () => {});
            break;
        case 'catalog':
            if (place.clearFilter) moves.clearCatalogFilter();
            nav.setView({ kind: 'catalog' });
            nav.select(dest.select, { highlight: false });
            break;
        case 'source':
            nav.select(dest.select, { highlight: false });
            break;
    }
    if (dest.inspector) moves.openInspector(dest.inspector);
}
