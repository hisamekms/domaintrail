import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { Messages } from '../i18n';
import type { View } from './navigation';

/**
 * The view tabs, in order. The storming tab shows even without a storming: a workspace started from nothing shows that
 * it can have one (the AI in the chat writes the `.dtes` on request).
 */
export const VIEW_TABS: readonly View['kind'][] = ['contextMap', 'structure', 'catalog', 'storming'];

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

/** The one line an empty view shows: with an AI connected to the chat, that asking there makes it. */
export const emptyLine = (t: Messages, aiReady: boolean): string => (aiReady ? t.emptyViewAskAi : t.emptyView);
