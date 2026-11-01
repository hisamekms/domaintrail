// The seed's agent: the real subscriber of `dt session subscribe` (claim, start, heartbeats, the scan of what changed,
// `dt fmt` / `dt check` with the built CLI, then finish / clarification / decline / fail over the agent API), with a
// scripted runner in place of Claude Code. Each step a scenario expects is queued before its run, and the runs are
// taken in queue order, one at a time: the next invocation plays the next step. A step edits the workspace for real
// and returns the structured reply the scenario wrote, validated as a real reply is.
import {
    type AgentInvocation,
    type AgentOutcome,
    type AgentRunner,
    createDtTools,
    createHttpAgentApi,
    type DtCommand,
    randomNonce,
    scanWorkspace,
    startSubscriber,
    type Subscriber,
    systemClock,
} from '@domaintrail/agent';
import { readCredential } from '@domaintrail/dt';
import { plainQuestion, readReply, type ReplyData, requestNumber } from '@domaintrail/collaboration';
import { sourceSelection } from '@domaintrail/modeling';
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
    /** Runs until it is stopped (a cancel): the scenario cancels the run once it is running. */
    | { readonly kind: 'hang' };

export interface FakeAgent {
    /** The step of the next run the facilitator queues: call it before queueing that run. */
    expect(step: Step): void;
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
                        invocation.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
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

/** Subscribes the scripted agent to the session server running on `root`. */
export async function startFakeAgent(options: FakeAgentOptions): Promise<FakeAgent> {
    const credential = await readCredential(options.root);
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
    return {
        expect: (step) => void steps.push(step),
        pending: () => steps.length,
        async stop() {
            await subscriber.stop();
        },
    };
}
