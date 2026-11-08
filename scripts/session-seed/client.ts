// The session's REST API as a seeded participant calls it (`/api/session/*`), with the participant's own `dev` cookie:
// the same requests a page sends. Every failure throws with the route, the status and the server's error, so that a
// seed stops loudly where it went wrong.
import type {
    AddressedBody,
    ApproveBody,
    ApprovedBody,
    MarkSetBody,
    Me,
    QueueRunBody,
    SendRequestBody,
    SessionStateBody,
    SetMarkBody,
    RevertRequestedBody,
} from '@domaintrail/collaboration/protocol';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];

/** A call of the session API that did not answer 2xx. */
export class SeedApiError extends Error {
    constructor(
        readonly route: string,
        readonly status: number,
        readonly body: string,
    ) {
        super(`${route} answered ${status}: ${body.slice(0, 500)}`);
    }
}

/** A participant signed in with a name: its cookie, and who the server says it is. */
export interface Participant {
    readonly name: string;
    /** `dt_session=<secret>`: what a browser sends. */
    readonly cookie: string;
    me: Me;
}

const json = { 'content-type': 'application/json' };

async function call<T>(base: string, route: string, cookie: string | undefined, body?: unknown): Promise<{ value: T; headers: Headers }> {
    let res: Response;
    try {
        res = await fetch(`${base}api/session/${route}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { ...(cookie && { cookie }), ...(body !== undefined && json) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(60_000),
        });
    } catch (e) {
        throw new Error(`${route}: the session server did not answer (${e instanceof Error ? e.message : String(e)})`, { cause: e });
    }
    const text = await res.text();
    if (!res.ok) throw new SeedApiError(`${body === undefined ? 'GET' : 'POST'} /api/session/${route}`, res.status, text);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the answer of this route of our own server (protocol.ts)
    return { value: JSON.parse(text) as T, headers: res.headers };
}

/** The session API of one server (`base` ends in `/`). */
export function sessionClient(base: string): {
    join(name: string): Promise<Participant>;
    claimFacilitator(p: Participant, link: string): Promise<void>;
    facilitatorLink(p: Participant): Promise<string>;
    state(p: Participant): Promise<SessionStateBody>;
    targets(p: Participant): Promise<{ statuses: Record<string, string[]> }>;
    send(p: Participant, body: SendRequestBody): Promise<RequestJson>;
    address(p: Participant, request: string): Promise<AddressedBody>;
    queue(p: Participant, body: QueueRunBody): Promise<RunJson>;
    cancel(p: Participant, run: string): Promise<RunJson>;
    mark(p: Participant, body: SetMarkBody): Promise<MarkSetBody>;
    approve(p: Participant, body: ApproveBody): Promise<ApprovedBody>;
    revert(p: Participant, run: string, body: string): Promise<RevertRequestedBody>;
} {
    return {
        async join(name) {
            const { value, headers } = await call<Me>(base, 'join', undefined, { name });
            const cookie = (headers.get('set-cookie') ?? '').split(';')[0] ?? '';
            if (!cookie.startsWith('dt_session=')) throw new Error(`join ${name}: no session cookie in the answer`);
            return { name, cookie, me: value };
        },
        async claimFacilitator(p, link) {
            const code = new URL(link).searchParams.get('code');
            if (!code) throw new Error(`Not a facilitator link: ${link}`);
            p.me = (await call<Me>(base, 'facilitator/claim', p.cookie, { code })).value;
            if (p.me.participant.role !== 'facilitator') throw new Error(`${p.name} claimed the facilitator link but is ${p.me.participant.role}`);
        },
        async facilitatorLink(p) {
            return (await call<{ link: string }>(base, 'facilitator/link', p.cookie, {})).value.link;
        },
        state: async (p) => (await call<SessionStateBody>(base, 'state', p.cookie)).value,
        targets: async (p) => (await call<{ statuses: Record<string, string[]> }>(base, 'targets', p.cookie)).value,
        send: async (p, body) => (await call<{ request: RequestJson }>(base, 'requests', p.cookie, body)).value.request,
        // the facilitator's 「AI に送る」 on one message (ADR 0030): its triage opens, addressed by the facilitator
        address: async (p, request) => (await call<AddressedBody>(base, `requests/${request}/address`, p.cookie, {})).value,
        queue: async (p, body) => (await call<{ run: RunJson }>(base, 'runs', p.cookie, body)).value.run,
        cancel: async (p, run) => (await call<{ run: RunJson }>(base, `runs/${run}/cancel`, p.cookie, {})).value.run,
        mark: async (p, body) => (await call<MarkSetBody>(base, 'marks', p.cookie, body)).value,
        approve: async (p, body) => (await call<ApprovedBody>(base, 'approvals', p.cookie, body)).value,
        revert: async (p, run, body) => (await call<RevertRequestedBody>(base, `runs/${run}/revert`, p.cookie, { body })).value,
    };
}

export type SessionClient = ReturnType<typeof sessionClient>;
