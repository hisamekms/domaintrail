// The IDs of Collaboration from values known to be UUIDs: those of the ID generator, and input already checked. The
// generated constructors check the form (ADR 0028); a value that fails it here is a programming error, never input.
import { Collaboration, type Result } from '../generated/index.js';

function known<T>(made: Result<T, { readonly type: string; readonly value: string }>): T {
    if (!made.ok) throw new Error(`Not a UUID (${made.error.type}): ${made.error.value}`);
    return made.value;
}

export const knownSessionId = (v: string): Collaboration.SessionId => known(Collaboration.makeSessionId(v));
export const knownRevisionId = (v: string): Collaboration.RevisionId => known(Collaboration.makeRevisionId(v));
export const knownRequestId = (v: string): Collaboration.RequestId => known(Collaboration.makeRequestId(v));
export const knownMarkId = (v: string): Collaboration.MarkId => known(Collaboration.makeMarkId(v));
export const knownAgentRunId = (v: string): Collaboration.AgentRunId => known(Collaboration.makeAgentRunId(v));
