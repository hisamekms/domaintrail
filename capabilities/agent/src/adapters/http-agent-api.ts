// The agent API over HTTP (ADR 0026, S4's `createAgentApi`): JSON calls with the bearer token of `agent.json`, and the
// SSE stream parsed here (`id:`, `event:`, `data:`, comments), resumed with `Last-Event-ID`. The token is sent only to
// the URL of `agent.json` (loopback) and never logged.
import {
    AGENT_ANSWER_EVENT_TYPES,
    type AgentAnswerJobBody,
    type AgentClaimed,
    type AgentLease,
    type AgentParticipantsBody,
    type AgentSessionBody,
    type EventMessage,
} from '@domaintrail/collaboration/protocol';
import { AgentApiError, type AgentApi, type AnswerStreamItem, type ApiResult, type Started, type StreamItem } from '../core/ports.js';

/** How long a call may take (a start or a finish takes a snapshot of the workspace on the server). */
const CALL_TIMEOUT_MS = 120_000;

export interface HttpAgentApiOptions {
    /** The agent API's base URL (`agent.json`'s `url`, ending in `/`). */
    readonly url: string;
    readonly token: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `type` of an error answer (`{ "error": { "type": … } }`), else the status text. */
async function errorType(res: Response): Promise<string> {
    const text = await res.text();
    try {
        const body: unknown = JSON.parse(text);
        if (isObject(body) && isObject(body.error) && typeof body.error.type === 'string') return body.error.type;
    } catch {
        // not JSON (a proxy's page, a crash): the status says enough
    }
    return res.statusText || 'Error';
}

/** One SSE event as parsed: its fields. */
interface RawEvent {
    id?: string;
    event: string;
    data: string[];
}

/** Splits an SSE body into events (the parts of the format the agent API uses: `id`, `event`, `data`, comments). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event: string; data: string }> {
    const decoder = new TextDecoder();
    let buffer = '';
    let pending: RawEvent = { event: 'message', data: [] };
    const reader = body.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            for (;;) {
                const nl = buffer.search(/\r\n|\r|\n/);
                if (nl < 0) break;
                // a lone \r at the end may be the first half of \r\n: wait for more
                if (buffer[nl] === '\r' && nl === buffer.length - 1 && !done) break;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
                if (line === '') {
                    if (pending.data.length || pending.id !== undefined) yield { id: pending.id, event: pending.event, data: pending.data.join('\n') };
                    pending = { event: 'message', data: [] };
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const raw = colon < 0 ? '' : line.slice(colon + 1);
                const v = raw.startsWith(' ') ? raw.slice(1) : raw;
                if (field === 'id') pending.id = v;
                else if (field === 'event') pending.event = v;
                else if (field === 'data') pending.data.push(v);
            }
            if (done) return;
        }
    } finally {
        reader.releaseLock();
    }
}

export function createHttpAgentApi(options: HttpAgentApiOptions): AgentApi {
    const base = options.url.endsWith('/') ? options.url : `${options.url}/`;
    const authorization = `Bearer ${options.token}`;

    const call = async <T>(method: 'GET' | 'POST', path: string, body?: object): Promise<ApiResult<T>> => {
        const res = await fetch(`${base}agent/${path}`, {
            method,
            headers: { authorization, ...(body && { 'content-type': 'application/json' }) },
            ...(body && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, status: res.status, type: await errorType(res) };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the agent API's answer of this route (protocol.ts), from the server of the same version
        return { ok: true, value: (await res.json()) as T };
    };
    const runPath = (run: string, action: string): string => `runs/${encodeURIComponent(run)}/${action}`;

    return {
        session: () => call<AgentSessionBody>('GET', 'session'),
        participants: () => call<AgentParticipantsBody>('GET', 'participants'),
        async *events(lastEventId, signal): AsyncGenerator<StreamItem> {
            const res = await fetch(`${base}agent/events`, {
                headers: { authorization, accept: 'text/event-stream', ...(lastEventId !== undefined && { 'last-event-id': lastEventId }) },
                signal,
            });
            if (!res.ok) throw new AgentApiError(res.status, await errorType(res));
            if (!res.body) throw new Error('The event stream has no body');
            yield { kind: 'open' };
            for await (const e of parseSse(res.body)) {
                if (e.id === undefined || !e.data) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(e.data);
                } catch (error) {
                    throw new Error(`Event ${e.id} is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
                if (!isObject(parsed) || typeof parsed.type !== 'string' || !isObject(parsed.event)) throw new Error(`Event ${e.id} is not an event message`);
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an outbox event as the server encodes it (protocol.ts), checked for its shape above
                yield { kind: 'event', id: e.id, type: e.event, message: parsed as unknown as EventMessage };
            }
        },
        claim: (owner, capabilities) => call<AgentClaimed>('POST', 'runs/claim', { owner, capabilities }),
        start: (run, token, since) => call<Started>('POST', runPath(run, 'start'), { token, ...(since !== undefined && { since }) }),
        heartbeat: (run, token) => call<{ lease: AgentLease }>('POST', runPath(run, 'heartbeat'), { token }),
        activity: (run, token, activity) => call('POST', runPath(run, 'activity'), { token, ...activity }),
        finish: (run, token, facts) => call('POST', runPath(run, 'finish'), { token, ...facts }),
        clarification: (run, token, question, reply) => call('POST', runPath(run, 'clarification'), { token, question, ...(reply && { reply }) }),
        decline: (run, token, reply) => call('POST', runPath(run, 'decline'), { token, reply }),
        fail: (run, token, reason) => call('POST', runPath(run, 'fail'), { token, reason }),
        release: (run, token) => call('POST', runPath(run, 'release'), { token }),
        async *answerEvents(signal): AsyncGenerator<AnswerStreamItem> {
            const res = await fetch(`${base}agent/answers/events`, { headers: { authorization, accept: 'text/event-stream' }, signal });
            if (!res.ok) throw new AgentApiError(res.status, await errorType(res));
            if (!res.body) throw new Error('The answer stream has no body');
            yield { kind: 'open' };
            for await (const e of parseSse(res.body)) {
                let data: unknown;
                try {
                    data = e.data ? JSON.parse(e.data) : {};
                } catch (error) {
                    throw new Error(`An answer event is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
                switch (e.event) {
                    case AGENT_ANSWER_EVENT_TYPES.job:
                        if (!isObject(data) || typeof data.job !== 'string' || typeof data.kind !== 'string') throw new Error('An answer job without its ID');
                        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a job as the server encodes it (protocol.ts), checked for its ID and kind above
                        yield { kind: 'job', job: data as unknown as AgentAnswerJobBody };
                        break;
                    case AGENT_ANSWER_EVENT_TYPES.withdrawn:
                        if (isObject(data) && typeof data.job === 'string') yield { kind: 'withdrawn', job: data.job };
                        break;
                    case AGENT_ANSWER_EVENT_TYPES.restored:
                        yield { kind: 'restored' };
                        break;
                    case AGENT_ANSWER_EVENT_TYPES.closed:
                        yield { kind: 'closed' };
                        break;
                    default:
                    // an event of a later server: not this answerer's
                }
            }
        },
        answerResult: (job, result) => call('POST', `answers/${encodeURIComponent(job)}`, result),
    };
}
