// `dt open` (ADR 0030, decision 2; plan modes, "State in .domaintrail/ per mode"): a session in the Solo mode has one
// person, on loopback, signed in as the facilitator without a form, a cookie or a facilitator link. Every request the
// server lets in (loopback only, with the Host and Origin guards of the dev mode) is that person; nothing signs in,
// claims the role or signs out. Their name is git's `user.name`, else the OS user's.
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { Collaboration, err, FACILITATOR_NAME, FACILITATOR_PARTICIPANT, type Identity, participantOf } from '@domaintrail/collaboration';
import type { Identified, SessionIdentities } from '../server/session/identities.js';

/** The identity of the one person of a Solo session. */
const SOLO_IDENTITY = { provider: 'dev', subject: 'solo' } as const;

/**
 * The identities of a Solo session: every request is its one person, the facilitator, while the session is open
 * (`isOpen`); `base` closes them. Signing in and claiming the role are refused (no one else joins a Solo session).
 */
export function soloIdentities(base: SessionIdentities, name: Collaboration.DisplayName, isOpen: () => Promise<boolean>): SessionIdentities {
    const identity: Identity = { ...SOLO_IDENTITY, displayName: name };
    const who: Identified = {
        participant: { id: FACILITATOR_PARTICIPANT, identity },
        role: 'facilitator',
        actor: { kind: 'participant', participant: FACILITATOR_PARTICIPANT, role: 'Facilitator', identity: SOLO_IDENTITY },
    };
    let closed = false;
    return {
        mode: base.mode,
        identify: async () => (!closed && (await isOpen()) ? who : undefined),
        signIn: async () => err({ type: 'SoloSession' }),
        signOut: async () => undefined,
        claimFacilitator: async () => err({ type: 'LinkInvalid' }),
        facilitatorParticipant: async () => (closed ? undefined : participantOf(SOLO_IDENTITY)),
        closeAll: async () => {
            closed = true;
            return base.closeAll();
        },
    };
}

/** git's `user.name` in `root`, if set (git may be missing). */
function gitUserName(root: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile('git', ['config', 'user.name'], { cwd: root, timeout: 2_000, windowsHide: true }, (error, stdout) =>
            resolve(error ? undefined : stdout.trim() || undefined),
        );
    });
}

/** The OS user's name, if it can be read. */
function osUserName(): string | undefined {
    try {
        return userInfo().username || undefined;
    } catch {
        return undefined;
    }
}

/** The name of the person of a Solo session: git's `user.name` in `root`, else the OS user's, else `Facilitator`. */
export async function soloName(root: string): Promise<Collaboration.DisplayName> {
    for (const raw of [await gitUserName(root), osUserName()]) {
        const name = raw === undefined ? undefined : Collaboration.makeDisplayName(raw.slice(0, 200));
        if (name?.ok) return name.value;
    }
    return FACILITATOR_NAME;
}
