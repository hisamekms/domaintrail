import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { Messages } from '../i18n';
import type { View } from './navigation';
import { worldOf } from './worlds';

/**
 * Whether a view has nothing yet: no BC in the model for the model's views, no storming for the storming view. A file of
 * that kind with errors is not "nothing": the view says why it draws nothing instead.
 */
export function isEmptyView(view: View['kind'], current: Pick<ViewPayload, 'model' | 'stormings' | 'diagnostics'>): boolean {
    const storming = view === 'storming';
    const nothing = storming ? current.stormings.length === 0 : (current.model?.contexts.length ?? 0) === 0;
    const ext = storming ? '.dtes' : '.dt';
    return nothing && !current.diagnostics.some((d) => d.severity === 'error' && d.file.endsWith(ext));
}

/**
 * What the canvas shows under a view: its graph, nothing, or what it drew last, covered by the catalog. An empty view
 * shows nothing on the canvas (an empty catalog is not drawn, so it would leave the previous view's graph in sight).
 */
export function canvasShows(view: View['kind'], empty: boolean, hasGraph: boolean): 'graph' | 'nothing' | 'covered' {
    if (empty) return 'nothing';
    if (view === 'catalog') return 'covered';
    return hasGraph ? 'graph' : 'nothing';
}

/**
 * The one line an empty view shows: with an AI connected to the chat (and the person able to start one), the command
 * of the view's own world that starts it there — `/es:start` under the storming view, `/model:start` under the model's
 * views (a context map, a structure or a catalog of no BC, even with stormings).
 */
export const emptyLine = (t: Messages, view: View['kind'], aiReady: boolean): string => {
    if (!aiReady) return t.emptyView;
    return worldOf(view) === 'storming' ? t.emptyViewStartEs : t.emptyViewStartModel;
};

/**
 * Whether an empty view may point to its `/…:start`: in a session not ended, with an AI connected, to who may start an
 * interview (`/es:start` and `/model:start` alike: the facilitator; in Solo, the person, who is it).
 */
export const canStartFromEmpty = (session: { ended: boolean; facilitator: boolean; aiConnected: boolean }): boolean =>
    !session.ended && session.facilitator && session.aiConnected;
