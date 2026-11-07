// What a printed or exported diagram is (`@domaintrail/visualization`'s sheet: its heading and its file's name), and what
// the workspace and the state view show, as a sheet's subject.
import { stormingSheetSubject, type SheetSubject, type StructureLevel } from '@domaintrail/visualization';
import type { DomainModel } from '@domaintrail/modeling';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { shownStorming, type StormingChoice } from '../storming';

export { exportFileName, sheetHeading, slug, type Named, type SheetSubject, type StormingScope } from '@domaintrail/visualization';

/** What the Event Storming view shows for `choice` (as `shownStorming` picks it), as a sheet's subject. */
export function stormingSubject(stormings: readonly StormingView[], choice: StormingChoice): SheetSubject | undefined {
    const shown = shownStorming(stormings, choice);
    return shown && stormingSheetSubject(shown.storming, shown.options);
}

/** What a canvas view of the workspace shows, as its toolbar sets it (none for the catalog, or nothing to show). */
export function canvasSubject(
    view: 'contextMap' | 'structure' | 'storming' | 'catalog',
    settings: { structureLevel: StructureLevel; mapAll: boolean; stormingChoice: StormingChoice },
    /** The focused contexts of the Structure View (none: every context). */
    focused: readonly string[],
    model: DomainModel | null,
    stormings: readonly StormingView[],
): SheetSubject | undefined {
    switch (view) {
        case 'contextMap':
            return { view, all: settings.mapAll };
        case 'structure':
            return {
                view,
                level: settings.structureLevel,
                contexts: focused.map((id) => ({ id, label: model?.contexts.find((c) => c.name === id)?.label })),
            };
        case 'storming':
            return stormingSubject(stormings, settings.stormingChoice);
        case 'catalog':
            return undefined;
    }
}
