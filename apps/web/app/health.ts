// What the head and the foot of the left pane say, without React: the workspace's name and the page's health at a glance.
import type { ViewStatus } from '@domaintrail/visualization/protocol';
import type { Connection } from './useViewSocket';

/** 正常 / 警告 / エラー. */
export type Health = 'ok' | 'warning' | 'error';

/**
 * How the page is doing: an error when the server is gone or the model does not validate, a warning while connecting,
 * with no sources, an older diagram shown or warnings in the sources, else fine. Before the first update it is
 * connecting (a warning).
 */
export function healthOf(input: { status: ViewStatus | undefined; connection: Connection; stale: boolean; warnings: number }): Health {
    if (input.connection === 'closed' || input.status === 'invalid' || input.status === 'syntax-error') return 'error';
    if (input.connection === 'connecting' || input.status === undefined || input.status === 'empty' || input.stale || input.warnings > 0) return 'warning';
    return 'ok';
}

/** The workspace's name: the last folder of its root (no `domaintrail.jsonc` names it). */
export function workspaceName(root: string): string | undefined {
    return root.split(/[\\/]/).findLast((part) => part !== '');
}
