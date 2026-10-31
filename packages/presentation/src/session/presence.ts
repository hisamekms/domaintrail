// Presence (ADR 0026): where each page of a session looks, its cursor and its selection. Ephemeral: kept in memory
// while the page is connected, never stored. Updates of one participant are sent on at most every 50 ms (~20 Hz,
// counted over all their pages); a faster update replaces the one waiting, so the last position always arrives.
import type { ClientMessage, Presence, PublicParticipant } from '@domaintrail/collaboration/protocol';
import type { Connection, WebSocketHub } from '../websocket/hub.js';
import type { Identified } from './identities.js';

/** What the hub knows of a page in a session. */
export type SessionConnection = Identified;

/** The shortest time between two presence updates of one participant. */
export const PRESENCE_INTERVAL_MS = 50;

export interface PresenceRelay {
    /** A page connected: it is sent the presence of the others. */
    connected(connection: Connection<SessionConnection>): void;
    received(connection: Connection<SessionConnection>, message: ClientMessage): void;
    /** A page left (closed, or sent `presence.leave`): the others are told. */
    left(connection: Connection<SessionConnection>): void;
    /** Drops every pending update (the server stops). */
    dispose(): void;
}

export const publicParticipant = (who: Identified): PublicParticipant => ({
    id: who.participant.id,
    name: who.participant.identity.displayName,
    role: who.role,
    ...(who.participant.identity.avatarUrl && { avatarUrl: who.participant.identity.avatarUrl }),
});

export function createPresenceRelay(hub: Pick<WebSocketHub<SessionConnection>, 'publishWhere'>, now: () => number = Date.now): PresenceRelay {
    const presences = new Map<string, Presence>();
    /** When each participant's last update was sent. */
    const lastSent = new Map<string, number>();
    /** The update waiting for its participant's interval, by participant. */
    const waiting = new Map<string, { connection: Connection<SessionConnection>; presence: Presence; timer: ReturnType<typeof setTimeout> }>();

    const others = (connection: Connection<SessionConnection>) => (c: Connection<SessionConnection>) => c.id !== connection.id;

    const send = (connection: Connection<SessionConnection>, presence: Presence): void => {
        lastSent.set(connection.data.participant.id, now());
        presences.set(connection.id, presence);
        hub.publishWhere(others(connection), { type: 'presence.update', presence });
    };

    const forget = (connection: Connection<SessionConnection>): void => {
        const pending = waiting.get(connection.data.participant.id);
        if (pending?.connection.id === connection.id) {
            clearTimeout(pending.timer);
            waiting.delete(connection.data.participant.id);
        }
    };

    return {
        connected(connection) {
            connection.send({ type: 'presence.snapshot', peers: [...presences.values()] });
        },

        received(connection, message) {
            if (message.type === 'presence.leave') return this.left(connection);
            const presence: Presence = {
                connection: connection.id,
                participant: publicParticipant(connection.data),
                location: message.location,
                ...(message.cursor && { cursor: message.cursor }),
                ...(message.selectedTarget && { selectedTarget: message.selectedTarget }),
            };
            const participant = connection.data.participant.id;
            const pending = waiting.get(participant);
            if (pending) {
                // an update of the participant waits for the interval: this one takes its place
                waiting.set(participant, { ...pending, connection, presence });
                return;
            }
            const wait = (lastSent.get(participant) ?? -Infinity) + PRESENCE_INTERVAL_MS - now();
            if (wait <= 0) return send(connection, presence);
            const timer = setTimeout(() => {
                const due = waiting.get(participant);
                waiting.delete(participant);
                if (due) send(due.connection, due.presence);
            }, wait);
            waiting.set(participant, { connection, presence, timer });
        },

        left(connection) {
            forget(connection);
            if (presences.delete(connection.id)) hub.publishWhere(others(connection), { type: 'presence.leave', connection: connection.id });
        },

        dispose() {
            for (const { timer } of waiting.values()) clearTimeout(timer);
            waiting.clear();
            presences.clear();
        },
    };
}
