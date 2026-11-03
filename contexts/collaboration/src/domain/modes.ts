// The two modes of a session (ADR 0030, decision 1; plan decision 13): `dt open` opens a Solo session, `dt collab` a
// Collab one, one open session per workspace. `dt open` refuses on a workspace whose open session is Collab (it is
// resumed with `dt collab`, or ended from its collab menu); `dt collab` continues a Solo session as a Collab one, its
// person staying the facilitator and its history kept. Pure: the use case `openSession` acts on it.
import type { Collaboration } from '../generated/index.js';

/** What opening a session of `wanted` mode does, given the workspace's open session (if any). */
export type SessionOpening = 'start' | 'resume' | 'collaborate' | 'refuse';

export function sessionOpening(current: { readonly mode: Collaboration.SessionMode } | undefined, wanted: Collaboration.SessionMode): SessionOpening {
    if (!current) return 'start';
    if (current.mode === wanted) return 'resume';
    return wanted === 'Collab' ? 'collaborate' : 'refuse';
}
