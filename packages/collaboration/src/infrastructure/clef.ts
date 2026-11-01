// The classifier adapter of Cloudflare's Clef (Workers AI): one yes/no ("noul") question per message, asked over the
// Workers AI REST API (`POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}`
// with `{ model, state, questions }`, answered `{ answers: { <id>: { type: "noul", noul: <probability> } } }`, wrapped in
// Cloudflare's `{ result, success }`). Neither the message nor the token is logged.
import type { ClefModel } from '@domaintrail/modeling/core/config';
import type { MessageClassifier } from '../application/classifier.js';

export interface ClefOptions {
    readonly accountId: string;
    readonly model: ClefModel;
    readonly token: string;
    /** The API's base URL (default Cloudflare's; the tests point it at a local mock). */
    readonly baseUrl?: string;
    readonly fetch?: typeof fetch;
}

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** The longest message text sent (Clef truncates long states anyway). */
const MAX_STATE = 4000;
const QUESTION = 'request';

/** The request body for a message. */
export function clefRequest(model: ClefModel, text: string): unknown {
    return {
        model,
        state: text.slice(0, MAX_STATE),
        questions: {
            [QUESTION]: {
                type: 'noul',
                instructions:
                    'This is a message in the chat of a domain modeling session, where an AI agent edits the domain model on request. Does it ask for a change to the domain model (a request to add, change, rename or remove something, or a question the agent should act on), rather than conversation among the participants?',
                criteria: {
                    true: 'A request for the agent to change the domain model.',
                    false: 'Conversation, a reaction, a greeting or a remark that asks nothing of the agent.',
                },
            },
        },
    };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The probability in Clef's answer (bare, or in Cloudflare's `result`); throws when the answer has none. */
export function clefProbability(body: unknown): number {
    const result = isObject(body) && isObject(body.result) ? body.result : body;
    const answers = isObject(result) ? result.answers : undefined;
    const answer = isObject(answers) ? answers[QUESTION] : undefined;
    const p = isObject(answer) ? answer.noul : undefined;
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error('Clef answered without a probability');
    return p;
}

export function createClefClassifier(options: ClefOptions): MessageClassifier {
    const doFetch = options.fetch ?? fetch;
    const url = `${options.baseUrl ?? CLOUDFLARE_API}/accounts/${encodeURIComponent(options.accountId)}/ai/run/@cf/cloudflare/${options.model}`;
    return {
        async classify(text, signal) {
            const res = await doFetch(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(clefRequest(options.model, text)),
                signal,
            });
            if (!res.ok) throw new Error(`Workers AI answered ${res.status}`);
            return clefProbability(await res.json());
        },
    };
}
