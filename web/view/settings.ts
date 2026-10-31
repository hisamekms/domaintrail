import { STRUCTURE_LEVELS, type StructureLevel } from '../../src/graph/ir';
import { usePersistentState } from '../shared/layout';
import type { StormingChoice } from '../storming';

/** What each view draws (remembered per browser). */
export interface ViewSettings {
    /** Structure View: all fields (detail), names only in larger text (overview), or aggregates only (aggregates). */
    structureLevel: StructureLevel;
    setStructureLevel: (level: StructureLevel) => void;
    /** Structure View: the bounded contexts to draw (null = every context, including ones added later). */
    structureContexts: string[] | null;
    setStructureContexts: (contexts: string[] | null) => void;
    /** Focused Structure View: contexts whose stubs (and the dependencies on and from them) are not drawn. */
    hiddenContexts: string[];
    setHiddenContexts: (contexts: string[]) => void;
    /** Context Map: also show shared and ID-only contexts. */
    mapAll: boolean;
    setMapAll: (all: boolean) => void;
    /** Event Storming: the storming, its level and its timeline filter (the page's state, never written to a .dtes file). */
    stormingChoice: StormingChoice;
    setStormingChoice: (choice: StormingChoice) => void;
}

export function useViewSettings(): ViewSettings {
    const [savedLevel, setStructureLevel] = usePersistentState<StructureLevel>('domaintrail.structureMode', 'detail');
    const structureLevel = STRUCTURE_LEVELS.includes(savedLevel) ? savedLevel : 'detail';
    const [structureContexts, setStructureContexts] = usePersistentState<string[] | null>('domaintrail.structureContexts', null);
    const [hiddenContexts, setHiddenContexts] = usePersistentState<string[]>('domaintrail.structureHiddenContexts', []);
    const [mapAll, setMapAll] = usePersistentState('domaintrail.contextMapAll', false);
    const [stormingChoice, setStormingChoice] = usePersistentState<StormingChoice>('domaintrail.storming', {
        stormingId: undefined,
        level: 'big-picture',
        timelines: {},
    });
    return {
        structureLevel,
        setStructureLevel,
        structureContexts,
        setStructureContexts,
        hiddenContexts,
        setHiddenContexts,
        mapAll,
        setMapAll,
        stormingChoice,
        setStormingChoice,
    };
}
