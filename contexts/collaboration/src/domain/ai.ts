// The AI as a participant (ADR 0030, decision 3; the plan's "The AI as a participant"): a virtual participant with the
// reserved ID `ai`, part of every session without joining — never stored among `Session.participants`, never counted
// in `maxParticipants`, never the facilitator. It can be mentioned (`@AI[pN]`, the body's person tokens), and it is
// the author of its answers (messages written by the server's `answer` only). A reply to one of its messages is
// addressed to it.
import { Collaboration } from '../generated/index.js';

/** The participant ID reserved for the AI: never one of an identity (`<provider>:<subject>`, `local:facilitator`). */
export const AI_PARTICIPANT = 'ai' as const;

/** The AI's display name, as one types it after `@` (not translated). */
export const AI_NAME = 'AI';

const made = Collaboration.makeParticipantId(AI_PARTICIPANT);
if (!made.ok) throw new Error('The AI participant ID is not a participant ID');

/** The AI's participant ID as the model's type. */
export const AI_PARTICIPANT_ID: Collaboration.ParticipantId = made.value;

/** Whether a participant ID (or its JSON) is the AI's. */
export const isAi = (participant: string): boolean => participant === AI_PARTICIPANT;
