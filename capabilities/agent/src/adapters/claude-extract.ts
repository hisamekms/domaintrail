// The Claude Code adapter of the extractor role (ADR 0031, section 3): through the `claude` the user signed in to (no
// Anthropic API key in dt), with no settings file and no MCP server, as the other roles, and **no tools at all**
// (`--tools ""`): its prompt holds all it reads. The extractor's instructions are appended to the system prompt, then
// the job's stable part (the workspace's stickies, `ExtractTurn.context`), so that they and Claude Code's own are what
// the prompt cache keeps from one extraction to the next; the message holds the talk. A fresh process per extraction (an extraction a minute at most: a warm one would only pile up
// context), in a working directory of its own with nothing in it (no workspace file, no `CLAUDE.md`, is read). The model
// is the answerer's unless `agent.extract` names one. The model that answered and what the turn cost are read from the
// process's events. Neither the prompt nor the output is logged.
//
// The light model that decides first whether to extract (`gate`, stage 2) runs the same way — a fresh process, no tools
// at all, the same empty directory — with its own model (`agent.extract.gateModel`, Haiku unless configured; no
// effort: the light model is the point), its schema and its instructions in the system prompt.
import { extractorJsonSchema, gateJsonSchema } from '@domaintrail/knowledge';
import type { AnswerTurnResult, ExtractAgent, ExtractTurn } from '../core/ports.js';
import { extractorInstructions, gateInstructions } from '../core/extract-prompt.js';
import { runClaudeOnce } from './claude-answer.js';
import { type AgentCommand, CLAUDE, claudeArguments } from './claude-code.js';
import { DEFAULT_TRIAGE_MODEL } from './config.js';

export interface ClaudeExtractorOptions {
    /** The working directory: an empty directory of the extractor's own. */
    readonly root: string;
    readonly model?: string;
    readonly effort?: string;
    /** The light model's (`agent.extract.gateModel`); default `DEFAULT_TRIAGE_MODEL`. */
    readonly gateModel?: string;
    /** The program (default `claude` on the PATH); the tests start a fake agent. */
    readonly command?: AgentCommand;
}

/** The system prompt's addition: the instructions, then the job's stable part when it has one. */
const appended = (instructions: string, context: string | undefined): string => (context ? `${instructions}\n${context}` : instructions);

/** The arguments of an extraction: no tool at all, the extractor's schema, its instructions (and `context`) in the system prompt. */
export function extractorArguments(options: { readonly model?: string; readonly effort?: string } = {}, context?: string): string[] {
    return [
        ...claudeArguments([], undefined, { ...options, schema: extractorJsonSchema() }),
        '--append-system-prompt',
        appended(extractorInstructions(), context),
    ];
}

/** The arguments of the light model's question: no tool at all, its model, its schema, its instructions (and `context`) in the system prompt. */
export function gateArguments(options: { readonly model?: string } = {}, context?: string): string[] {
    return [
        ...claudeArguments([], undefined, { model: options.model ?? DEFAULT_TRIAGE_MODEL, schema: gateJsonSchema() }),
        '--append-system-prompt',
        appended(gateInstructions(), context),
    ];
}

export function createClaudeExtractor(options: ClaudeExtractorOptions): ExtractAgent {
    const command = options.command ?? CLAUDE;
    const extractOptions = {
        ...(options.model !== undefined && { model: options.model }),
        ...(options.effort !== undefined && { effort: options.effort }),
    };
    const gateModel = options.gateModel ?? DEFAULT_TRIAGE_MODEL;
    const turnOf = async (turn: ExtractTurn, argv: readonly string[], configured: string | undefined): Promise<AnswerTurnResult> => {
        try {
            const ran = await runClaudeOnce(command, argv, turn.prompt, options.root, turn.signal);
            if (turn.signal.aborted) return { text: '', error: 'stopped' };
            const model = ran.model ?? configured;
            const meta = { ...(model && { model }), ...(ran.result.usage && { usage: ran.result.usage }) };
            if (ran.exitCode !== 0) return { text: '', error: `claude exited with ${ran.exitCode}`, ...meta };
            return { text: ran.result.text, ...(ran.result.structured !== undefined && { structured: ran.result.structured }), ...meta };
        } catch (e) {
            return { text: '', error: e instanceof Error ? e.message : String(e) };
        }
    };
    return {
        extract: (turn) => turnOf(turn, extractorArguments(extractOptions, turn.context), options.model),
        gate: (turn) => turnOf(turn, gateArguments({ model: gateModel }, turn.context), gateModel),
    };
}
