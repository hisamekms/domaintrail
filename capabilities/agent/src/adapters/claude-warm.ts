// The warm Claude Code runner of the subscriber's runs (the run role; plan modes, the warm agent): each run one turn
// of a warm process (`warm-claude.ts`) started with the arguments of a cold run (`claudeArguments`: the facilitator's
// tools, the user's settings only, `dontAsk`) and the reply's JSON schema for up to `SCHEMA_REQUESTS` requests (the
// schema is fixed per process; `parseReply` checks the run's real count; a run with more replaces the process). The
// agent's `dt` shim lives as long as the process. A run that continues the process's conversation gets the prompt
// that says what changed since its previous run (`continuedPrompt`). Besides the warm process's own reasons, a
// declined run replaces it (the turn may carry an attempt to break the rules). A turn the process never began (it did
// not start, or showed no sign of life) runs cold instead; once the warm process has failed too often, every run is
// cold (`createClaudeCodeRunner`).
import type { AgentInvocation, AgentOutcome, AgentRunner } from '../core/ports.js';
import { parseReply } from '../core/prompt.js';
import { activityOfEvent } from './claude-stream.js';
import { claudeArguments, type ClaudeCodeOptions, createClaudeCodeRunner, pinAgentDt, realpathOr } from './claude-code.js';
import { withPathFirst } from './dt-shim.js';
import { createWarmClaude, type WarmClaudeOptions } from './warm-claude.js';

/** Requests the schema of a process takes, at least. */
export const SCHEMA_REQUESTS = 20;

export interface WarmRunnerOptions
    extends
        ClaudeCodeOptions,
        Pick<
            WarmClaudeOptions,
            'restartAfter' | 'idleTimeoutMs' | 'contextLimit' | 'maxFailures' | 'startTimeoutMs' | 'interruptGraceMs' | 'closeGraceMs' | 'log'
        > {}

export async function createWarmClaudeRunner(options: WarmRunnerOptions): Promise<AgentRunner> {
    const roots = [...new Set([options.root, realpathOr(options.root)])];
    const agentDt = await pinAgentDt(options);
    const cold = await createClaudeCodeRunner(options);
    const flags = {
        streamInput: true,
        ...(options.model !== undefined && { model: options.model }),
        ...(options.effort !== undefined && { effort: options.effort }),
    };
    const warm = createWarmClaude({
        ...options,
        name: 'agent',
        // the agent's dt for the process's lifetime (checked again before each run)
        environment: async () => {
            const shim = await agentDt.shim();
            return shim ? { env: withPathFirst(process.env, shim.dir), dispose: () => shim.dispose() } : {};
        },
    });
    /** The most requests the schema of the current process takes. */
    let schemaRequests = SCHEMA_REQUESTS;

    const runWarm = async (invocation: AgentInvocation): Promise<AgentOutcome> => {
        const cancelled: AgentOutcome = { exitCode: -1, outcome: 'done', summary: '' };
        // a file of the agent's dt changed: the run fails to start, as a cold one does
        await agentDt.check();
        if (invocation.requests > schemaRequests) schemaRequests = invocation.requests;
        // what git ignores now: a change of it replaces the process (its arguments are its key)
        const { deniedPaths, extra } = (await options.readScope?.()) ?? { deniedPaths: [] };
        const args = claudeArguments(invocation.allowedTools, schemaRequests, {
            ...flags,
            deniedPaths,
            ...(extra && { extraRead: extra }),
            ...(options.configFiles && { configFiles: options.configFiles }),
            ...(options.knowledge && { knowledge: options.knowledge }),
        });
        const end = await warm.turn({
            profile: { args, key: JSON.stringify(args) },
            prompt: (continuing) => (continuing && invocation.continuedPrompt !== undefined ? invocation.continuedPrompt : invocation.prompt),
            signal: invocation.signal,
            onEvent: (event) => {
                const activity = invocation.onActivity && activityOfEvent(event, roots);
                if (activity) invocation.onActivity?.(activity);
            },
        });
        switch (end.kind) {
            case 'result': {
                const outcome: AgentOutcome = { exitCode: end.isError ? 1 : 0, ...parseReply(end.result.structured, end.result.text, invocation.requests) };
                if (outcome.outcome === 'declined') warm.reset('a run was declined');
                return outcome;
            }
            case 'cancelled':
                return cancelled;
            case 'silent':
                // nothing of the turn happened: this run goes to a process of its own
                return cold.run(invocation);
            case 'exit':
                if (invocation.signal.aborted) return cancelled;
                // it never took the turn: this run goes to a process of its own; a turn it began fails
                if (!end.started) return cold.run(invocation);
                return { exitCode: end.code === 0 ? 1 : end.code, outcome: 'done', summary: '' };
        }
    };

    return {
        run(invocation: AgentInvocation): Promise<AgentOutcome> {
            if (invocation.signal.aborted) return Promise.resolve({ exitCode: -1, outcome: 'done', summary: '' });
            return warm.coldOnly ? cold.run(invocation) : runWarm(invocation);
        },
        reset: (reason) => warm.reset(reason),
        close: () => warm.close(),
    };
}
