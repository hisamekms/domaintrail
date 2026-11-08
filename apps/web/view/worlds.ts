import { useCallback, useEffect } from 'react';
import { usePersistentState } from '../shared/layout';
import type { View } from './navigation';

/**
 * The two worlds the page shows, chosen in the app bar: the domain model (`.dt`), seen through three views, and event
 * storming (`.dtes`). The world is derived from the view; the view is what is kept and sent (`ViewLocation`).
 */
export type World = 'model' | 'storming';

export const WORLDS: readonly World[] = ['model', 'storming'];

/** The domain model's views, in the view bar's order. */
export type ModelView = 'contextMap' | 'structure' | 'catalog';

export const MODEL_VIEWS: readonly ModelView[] = ['contextMap', 'structure', 'catalog'];

/** localStorage key of the view shown (its kind; the world is derived from it), remembered per browser. */
export const VIEW_KEY = 'domaintrail.view';

/** localStorage key of the domain model's view to return to from the storming world, remembered per browser. */
export const MODEL_VIEW_KEY = 'domaintrail.modelView';

const isModelView = (v: unknown): v is ModelView => MODEL_VIEWS.some((m) => m === v);

/** The domain model's view a stored value names; anything else (nothing stored, an old value): the structure. */
export const rememberedModelView = (stored: unknown): ModelView => (isModelView(stored) ? stored : 'structure');

/** The view a stored value names; anything else (nothing stored, an old value): the structure. */
export const rememberedView = (stored: unknown): View => ({ kind: stored === 'storming' ? 'storming' : rememberedModelView(stored) });

export const worldOf = (view: View['kind']): World => (view === 'storming' ? 'storming' : 'model');

/** The domain model's view to return to, once `view` is shown: it, if it is one of the domain model's, else the last one. */
export const lastModelViewAfter = (last: ModelView, view: View['kind']): ModelView => (view === 'storming' ? last : view);

/** The view a world opens on: the domain model's last one, or the storming view. */
export const viewOfWorld = (world: World, lastModelView: ModelView): View => ({ kind: world === 'storming' ? 'storming' : lastModelView });

/** The world shown, and switching to the other one where it was left (its view; its storming and conditions are the settings'). */
export interface Worlds {
    world: World;
    setWorld: (world: World) => void;
}

export function useWorlds(view: View, setView: (v: View) => void): Worlds {
    const [stored, setLastModelView] = usePersistentState<ModelView>(MODEL_VIEW_KEY, 'structure');
    const lastModelView = rememberedModelView(stored);
    useEffect(() => {
        const next = lastModelViewAfter(lastModelView, view.kind);
        if (next !== lastModelView) setLastModelView(next);
    }, [view.kind, lastModelView, setLastModelView]);
    const world = worldOf(view.kind);
    const setWorld = useCallback(
        (w: World): void => {
            if (w !== world) setView(viewOfWorld(w, lastModelView));
        },
        [world, lastModelView, setView],
    );
    return { world, setWorld };
}
