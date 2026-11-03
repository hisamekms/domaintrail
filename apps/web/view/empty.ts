import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { Messages } from '../i18n';
import type { View } from './navigation';

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

/** The one line an empty view shows: with an AI connected to the chat (and the person able to start one), that `/es` there starts it. */
export const emptyLine = (t: Messages, aiReady: boolean): string => (aiReady ? t.emptyViewAskAi : t.emptyView);
