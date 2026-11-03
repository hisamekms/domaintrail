// The seed's agent: the real subscriber of `dt agent` (claim, start, heartbeats, the scan of what changed,
// `dt fmt` / `dt check` with the built CLI, then finish / clarification / decline / fail over the agent API), with a
// scripted runner in place of Claude Code. Each step a scenario expects is queued before its run, and the runs are
// taken in queue order, one at a time: the next invocation plays the next step. A step edits the workspace for real
// and returns the structured reply the scenario wrote, validated as a real reply is.
//
// Beside it, the real answerer role (`startAnswerer`) with a scripted agent in place of Claude Code: stage 3 of the
// triage reads a message the scenario sends to the AI for a run (`sendsForRun`) as a change request, any other as
// needing no answer; it answers and proposes nothing (`neither`: a proposal job, from a participant's reply the
// classifier read as a request, is then given up by the server until it restarts). The seeded timeline thus has no AI
// answer or proposal of its own.
import {
    type AgentInvocation,
    type AgentOutcome,
    type AgentRunner,
    type AnswerAgent,
    type AnswerTurnResult,
    type Answerer,
    startAnswerer,
    createDtTools,
    createHttpAgentApi,
    type DtCommand,
    randomNonce,
    scanWorkspace,
    startSubscriber,
    type Subscriber,
    systemClock,
} from '@domaintrail/agent';
import { issueAgentLink, pairAgent } from '@domaintrail/dt';
import { plainQuestion, readReply, type ReplyData, requestNumber, type RunActivity } from '@domaintrail/collaboration';
import { sourceSelection } from '@domaintrail/analysis';
import { findDomainFiles } from '@domaintrail/workspace';

/** A reply as a scenario writes it: requests by their number in the run (from 1); `questions` and `assumptions` optional. */
export type ScriptedReply = Omit<ReplyData<number>, 'questions' | 'assumptions'> & Partial<Pick<ReplyData<number>, 'questions' | 'assumptions'>>;

/** What the agent does on one run. */
export type Step =
    /** Edits the workspace (optional), then replies: done, a clarification or a decline. */
    | { readonly kind: 'reply'; readonly edit?: (root: string) => Promise<void>; readonly reply: ScriptedReply }
    /** Exits with a non-zero code without a reply: the run fails with its report. */
    | { readonly kind: 'exit'; readonly exitCode: number }
    /** Cannot run at all: the run fails (AgentError). */
    | { readonly kind: 'crash' }
    /**
     * Runs until it is stopped (a cancel): the scenario cancels the run once it is running. Meanwhile it tells what it
     * is doing, `HANG_ACTIVITIES` one after another every `HANG_ACTIVITY_MS`, round and round.
     */
    | { readonly kind: 'hang' };

export interface FakeAgent {
    /** The step of the next run the facilitator queues: call it before queueing that run. */
    expect(step: Step): void;
    /** Stage 3 reads the message with this text (as the prompt shows it, `plainBody`) as a change request. */
    sendsForRun(text: string): void;
    /** How many steps are still waiting for their run. */
    pending(): number;
    /** Stops the subscriber (no run is held afterwards). */
    stop(): Promise<void>;
}

export interface FakeAgentOptions {
    readonly root: string;
    /** `dt` for `dt fmt` / `dt check` after each step (the built CLI). */
    readonly dt: DtCommand;
    readonly log: (line: string) => void;
}

/** What a run left running tells it is doing (files of examples/shop), the way a real agent goes: it reads, edits, checks. */
const HANG_ACTIVITIES: readonly RunActivity[] = [
    { phase: 'reading', subject: 'stormings/returns.dtes' },
    { phase: 'reading', subject: 'sales/order.dt' },
    { phase: 'editing', subject: 'stormings/returns.dtes' },
    { phase: 'checking', subject: 'dt check' },
    { phase: 'editing', subject: 'sales/order.dt' },
    { phase: 'checking', subject: 'dt fmt' },
    { phase: 'finishing' },
];
/** How long each of them lasts. */
const HANG_ACTIVITY_MS = 3_000;

function scriptedRunner(steps: Step[], root: string): AgentRunner {
    return {
        async run(invocation: AgentInvocation): Promise<AgentOutcome> {
            const step = steps.shift();
            if (!step) throw new Error('The fake agent got a run no scenario expected');
            switch (step.kind) {
                case 'crash':
                    throw new Error('The fake agent could not start (scripted)');
                case 'exit':
                    return { exitCode: step.exitCode, outcome: 'done', summary: '' };
                case 'hang':
                    return new Promise<AgentOutcome>((_resolve, reject) => {
                        if (invocation.signal.aborted) return reject(new Error('stopped'));
                        let next = 0;
                        const tell = (): void => {
                            invocation.onActivity?.(HANG_ACTIVITIES[next]);
                            next = (next + 1) % HANG_ACTIVITIES.length;
                        };
                        tell();
                        const timer = setInterval(tell, HANG_ACTIVITY_MS);
                        invocation.signal.addEventListener(
                            'abort',
                            () => {
                                clearInterval(timer);
                                reject(new Error('stopped'));
                            },
                            { once: true },
                        );
                    });
                case 'reply': {
                    // the reply a scenario wrote is checked as Claude Code's would be: a mistake in a scenario fails loudly
                    const read = readReply({ questions: [], assumptions: [], ...step.reply }, requestNumber(invocation.requests), invocation.requests);
                    if (!read.ok) throw new Error(`A scripted reply is not valid: ${read.error.path}: ${read.error.message}`);
                    await step.edit?.(root);
                    const reply = read.value;
                    return {
                        exitCode: 0,
                        outcome: reply.outcome,
                        summary: reply.summary,
                        ...(reply.outcome === 'clarification' && { question: plainQuestion(reply) }),
                        reply,
                    };
                }
            }
        },
    };
}

/** The addressed message's text in a triage prompt (the JSON block between the `<message-…>` tags). */
function messageText(prompt: string): string | undefined {
    const block = /<message-[^>]+>\n([\s\S]*)\n<\/message-[^>]+>/.exec(prompt)?.[1];
    if (!block) return undefined;
    try {
        const data: unknown = JSON.parse(block);
        if (typeof data !== 'object' || data === null || !('message' in data)) return undefined;
        const message: unknown = data.message;
        return typeof message === 'object' && message !== null && 'text' in message && typeof message.text === 'string' ? message.text : undefined;
    } catch {
        return undefined;
    }
}

/** The answerer's scripted agent: stage 3 from the texts the scenarios send for a run; no answer, no proposal. */
function scriptedAnswerer(forRun: Set<string>): AnswerAgent {
    const structured = (value: Record<string, unknown>): AnswerTurnResult => ({ structured: value, text: JSON.stringify(value), model: 'seed' });
    return {
        async triage(turn) {
            const text = messageText(turn.prompt);
            if (text !== undefined && forRun.delete(text)) return structured({ kind: 'change_request', confidence: 0.95, reason: 'シードの台本: 変更の依頼' });
            return structured({ kind: 'neither', confidence: 0.95, reason: 'シードの台本にないメッセージ' });
        },
        answer: async () => structured({ kind: 'neither', reason: 'シードの台本にないメッセージ' }),
        interview: async () => ({ text: '', error: 'the seed runs no interview' }),
    };
}

/** Subscribes the scripted agent to the session server running on `root`. */
export async function startFakeAgent(options: FakeAgentOptions): Promise<FakeAgent> {
    // paired as a standalone `dt agent` is: a one-time code for the credential, kept in memory
    const credential = await pairAgent(options.root, (await issueAgentLink(options.root)).code);
    const api = createHttpAgentApi({ url: credential.url, token: credential.token });
    const session = await api.session();
    if (!session.ok) throw new Error(`The agent API refused the credential (${session.status} ${session.type})`);
    const steps: Step[] = [];
    const subscriber: Subscriber = startSubscriber(
        {
            api,
            runner: scriptedRunner(steps, options.root),
            tools: createDtTools({ dt: options.dt, root: options.root, log: options.log }),
            workspace: {
                scan: () => scanWorkspace(options.root),
                sources: async () => new Set(await findDomainFiles(options.root, sourceSelection())),
            },
            clock: systemClock,
            owner: 'seed-fake-agent',
            nonce: randomNonce,
            log: options.log,
        },
        { allowedTools: session.value.allowedTools, leaseMs: session.value.leaseMs },
    );
    const forRun = new Set<string>();
    const answerer: Answerer = startAnswerer({
        api,
        agent: scriptedAnswerer(forRun),
        workspace: { scan: () => scanWorkspace(options.root) },
        clock: systemClock,
        nonce: randomNonce,
        log: options.log,
    });
    return {
        expect: (step) => void steps.push(step),
        sendsForRun: (text) => void forRun.add(text),
        pending: () => steps.length,
        async stop() {
            await Promise.all([subscriber.stop(), answerer.stop()]);
        },
    };
}
