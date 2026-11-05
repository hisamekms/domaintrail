// The Claude Code adapter of the extractor role (ADR 0031, section 3): through the `claude` the user signed in to (no
// Anthropic API key in dt), with no settings file and no MCP server, as the other roles, and **no tools at all**
// (`--tools ""`): its prompt holds all it reads. The extractor's instructions are appended to the system prompt, so that
// they and Claude Code's own are the stable part the prompt cache keeps from one extraction to the next; the message
// holds the talk. A fresh process per extraction (an extraction a minute at most: a warm one would only pile up
// context), in a working directory of its own with nothing in it (no workspace file, no `CLAUDE.md`, is read). The model
// is the answerer's unless `agent.extract` names one. The model that answered and what the turn cost are read from the
// process's events. Neither the prompt nor the output is logged.
import { extractorJsonSchema } from '@domaintrail/knowledge';
import type { AnswerTurnResult, ExtractAgent } from '../core/ports.js';
import { extractorInstructions } from '../core/extract-prompt.js';
import { runClaudeOnce } from './claude-answer.js';
import { type AgentCommand, CLAUDE, claudeArguments } from './claude-code.js';

export interface ClaudeExtractorOptions {
    /** The working directory: an empty directory of the extractor's own. */
    readonly root: string;
    readonly model?: string;
    readonly effort?: string;
    /** The program (default `claude` on the PATH); the tests start a fake agent. */
    readonly command?: AgentCommand;
}

/** The arguments of an extraction: no tool at all, the extractor's schema, its instructions in the system prompt. */
export function extractorArguments(options: { readonly model?: string; readonly effort?: string } = {}): string[] {
    return [...claudeArguments([], undefined, { ...options, schema: extractorJsonSchema() }), '--append-system-prompt', extractorInstructions()];
}

export function createClaudeExtractor(options: ClaudeExtractorOptions): ExtractAgent {
    const command = options.command ?? CLAUDE;
    const args = extractorArguments({
        ...(options.model !== undefined && { model: options.model }),
        ...(options.effort !== undefined && { effort: options.effort }),
    });
    return {
        async extract(turn): Promise<AnswerTurnResult> {
            try {
                const ran = await runClaudeOnce(command, args, turn.prompt, options.root, turn.signal);
                if (turn.signal.aborted) return { text: '', error: 'stopped' };
                const model = ran.model ?? options.model;
                const meta = { ...(model && { model }), ...(ran.result.usage && { usage: ran.result.usage }) };
                if (ran.exitCode !== 0) return { text: '', error: `claude exited with ${ran.exitCode}`, ...meta };
                return { text: ran.result.text, ...(ran.result.structured !== undefined && { structured: ran.result.structured }), ...meta };
            } catch (e) {
                return { text: '', error: e instanceof Error ? e.message : String(e) };
            }
        },
    };
}
