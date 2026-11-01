// The clock, the IDs and the secrets of a running session.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock, IdGenerator, SecretGenerator } from '../application/ports.js';

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdGenerator = { newId: () => randomUUID() };

/** 32 random bytes, base64url (43 characters). */
export const randomSecrets: SecretGenerator = { newSecret: () => randomBytes(32).toString('base64url') };
