// The classifier adapter of Cloudflare's Clef (Workers AI) for stage 2 of the triage (ADR 0030, decision 4; the plan's
// "Stage 2: Clef"): three yes/no ("noul") questions in one call — is the message a question about the model (相談), a
// request to change it (依頼), or does it need no answer at all — asked over the Workers AI REST API (`POST
// https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}` with `{ model, state,
// questions }`, answered `{ answers: { <id>: { type: "noul", noul: <probability> } } }`, wrapped in Cloudflare's
// `{ result, success }`). The verdict is the domain's (`clefVerdict`): one question at or above the threshold decides.
// Neither the message nor the token is logged.
import type { ClefModel } from '../application/config.js';
import type { MessageClassifier } from '../application/classifier.js';
import type { ClefProbabilities } from '../domain/triage.js';

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

const CONTEXT =
    'This is a message addressed to the AI in the chat of a domain modeling session, where the AI answers questions about the domain model (the workspace’s .dt and .dtes files) and edits it on request.';

/** The three questions, by the ID Clef answers them under. */
export const CLEF_QUESTIONS = {
    consultation: {
        instructions: `${CONTEXT} Does it ask a question, an opinion or an explanation about the domain model, without asking to change it?`,
        criteria: {
            true: 'A question, a request for an opinion or an explanation about the model: nothing in it asks to change the files.',
            false: 'It asks for a change, or asks nothing of the AI.',
        },
    },
    change_request: {
        instructions: `${CONTEXT} Does it ask the AI to change the domain model (add, change, rename or remove something, or go ahead with a proposed change)?`,
        criteria: {
            true: 'A request to change the model, or an agreement to carry out a change proposed before.',
            false: 'A question, a remark, or anything that does not ask for a change.',
        },
    },
    neither: {
        instructions: `${CONTEXT} Does it need no answer from the AI at all (thanks, an acknowledgement, a greeting, a remark)?`,
        criteria: {
            true: 'Thanks, an acknowledgement, a greeting or a remark: nothing for the AI to answer or do.',
            false: 'It asks the AI something, or asks it to do something.',
        },
    },
} as const;

type QuestionId = keyof typeof CLEF_QUESTIONS;

/** The request body for a message. */
export function clefRequest(model: ClefModel, text: string): unknown {
    return {
        model,
        state: text.slice(0, MAX_STATE),
        questions: Object.fromEntries(Object.entries(CLEF_QUESTIONS).map(([id, q]) => [id, { type: 'noul', ...q }])),
    };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The probabilities in Clef's answer (bare, or in Cloudflare's `result`); throws when one of the three is missing. */
export function clefProbabilities(body: unknown): ClefProbabilities {
    const result = isObject(body) && isObject(body.result) ? body.result : body;
    const answers = isObject(result) ? result.answers : undefined;
    const of = (id: QuestionId): number => {
        const answer = isObject(answers) ? answers[id] : undefined;
        const p = isObject(answer) ? answer.noul : undefined;
        if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error(`Clef answered without a probability for ${id}`);
        return p;
    };
    return { consultation: of('consultation'), changeRequest: of('change_request'), neither: of('neither') };
}

export function createClefClassifier(options: ClefOptions): MessageClassifier {
    const doFetch = options.fetch ?? fetch;
    const url = `${options.baseUrl ?? CLOUDFLARE_API}/accounts/${encodeURIComponent(options.accountId)}/ai/run/@cf/cloudflare/${options.model}`;
    return {
        model: options.model,
        async classify(text, signal) {
            const res = await doFetch(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(clefRequest(options.model, text)),
                signal,
            });
            if (!res.ok) throw new Error(`Workers AI answered ${res.status}`);
            return clefProbabilities(await res.json());
        },
    };
}
