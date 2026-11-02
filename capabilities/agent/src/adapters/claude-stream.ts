// What `claude --print --output-format stream-json --verbose` prints, read as it comes (ADR 0026, amendment: what a
// running run is doing): one JSON event per line. The tool calls of the assistant's messages are mapped onto the
// protocol's activities, and the last `result` event is the run's result (its structured output and text), as the
// single JSON object of `--output-format json` was. Output that is not a stream (one JSON object, or text, as older or
// fake agents print) is read as before. Nothing here is logged; the page sees only the activities.
import * as path from 'node:path';
import { isActivitySubject } from '@domaintrail/collaboration';
import type { RunActivity } from '@domaintrail/collaboration/protocol';

/** What the agent printed in the end: the reply's structured output and the result text. */
export interface ClaudeResult {
    /** `structured_output` (with `--json-schema`): the reply as an object, before any validation of ours. */
    readonly structured?: unknown;
    /** `result`: the final text (the structured output as JSON with `--json-schema`), else the raw output. */
    readonly text: string;
}

/** Most characters kept of what is not a stream event (the fallback result), and of one line. */
export const MAX_OUTPUT = 8 * 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `result` event (or the JSON of `--output-format json`) as the result, if it is one. */
function resultEvent(value: unknown): ClaudeResult | undefined {
    if (!isObject(value) || typeof value.result !== 'string') return undefined;
    return { text: value.result, ...(value.structured_output != null && { structured: value.structured_output }) };
}

/** The result in `claude --output-format json`'s output (`{"type":"result","result":"…","structured_output":{…},…}`), else the raw output. */
export function resultOf(stdout: string): ClaudeResult {
    const text = stdout.trim();
    const candidates = [text, text.split('\n').at(-1) ?? ''];
    for (const candidate of candidates) {
        let value: unknown;
        try {
            value = JSON.parse(candidate);
        } catch {
            // not the JSON result (an older or a fake agent printing text): try the next, then the text itself
            continue;
        }
        const result = resultEvent(value);
        if (result) return result;
    }
    return { text };
}

/** The tools that read, and those that write, a file (or search a path). */
const READING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** The tool through which `--json-schema` takes the reply: the agent is writing its answer. */
const REPLY_TOOL = 'StructuredOutput';
/** A shell command that runs the agent's `dt` (the shim): `dt check`, `dt fmt a.dt`, … */
const DT_COMMAND = /^\s*dt\s+([a-z][a-z-]*)(?=\s|$)/;

/**
 * A path the agent named, relative to the workspace and `/`-separated, if it is inside it (below one of `roots`: the
 * workspace as given and its real path) and fit to show; undefined otherwise, and for the workspace itself.
 */
export function workspacePath(named: unknown, roots: readonly string[]): string | undefined {
    if (typeof named !== 'string' || !named || roots.length === 0) return undefined;
    for (const root of roots) {
        const relative = path.relative(root, path.resolve(roots[0], named));
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        const shown = relative.split(path.sep).join('/');
        return isActivitySubject(shown) ? shown : undefined;
    }
    return undefined;
}

/** The activity of one tool call of the agent, if the tool is one the phases know. */
export function toolActivity(name: string, input: unknown, roots: readonly string[]): RunActivity | undefined {
    const field = (key: string): unknown => (isObject(input) ? input[key] : undefined);
    const about = (phase: RunActivity['phase'], named: unknown): RunActivity => {
        const subject = workspacePath(named, roots);
        return subject === undefined ? { phase } : { phase, subject };
    };
    if (READING_TOOLS.has(name)) return about('reading', field('file_path') ?? field('notebook_path') ?? field('path'));
    if (EDITING_TOOLS.has(name)) return about('editing', field('file_path') ?? field('notebook_path'));
    if (name === REPLY_TOOL) return { phase: 'finishing' };
    if (name === 'Bash') {
        const command = field('command');
        const dt = typeof command === 'string' ? DT_COMMAND.exec(command) : null;
        return dt ? { phase: 'checking', subject: `dt ${dt[1]}` } : undefined;
    }
    return undefined;
}

/**
 * The activity one event of the stream tells: the last tool call of an assistant's message that maps onto a phase,
 * `finishing` for the result; nothing for anything else (text, tool results, system events, unknown events).
 */
export function activityOfEvent(event: unknown, roots: readonly string[]): RunActivity | undefined {
    if (!isObject(event)) return undefined;
    if (event.type === 'result') return { phase: 'finishing' };
    if (event.type !== 'assistant' || !isObject(event.message) || !Array.isArray(event.message.content)) return undefined;
    let found: RunActivity | undefined;
    for (const block of event.message.content as unknown[]) {
        if (isObject(block) && block.type === 'tool_use' && typeof block.name === 'string') found = toolActivity(block.name, block.input, roots) ?? found;
    }
    return found;
}

export interface StreamReader {
    /** The next chunk of stdout. */
    push(chunk: string): void;
    /** stdout ended: the result. */
    end(): ClaudeResult;
}

/**
 * Reads stdout line by line: each stream event (a JSON object with a `type`) goes to `onEvent`, the last `result`
 * event is the result; anything else is kept (up to `MAX_OUTPUT`) and read as `resultOf` reads the whole output.
 */
export function createStreamReader(onEvent: (event: Readonly<Record<string, unknown>>) => void): StreamReader {
    let line = '';
    /** A line past `MAX_OUTPUT` is dropped up to its end. */
    let skipping = false;
    let other = '';
    let result: ClaudeResult | undefined;

    const take = (text: string): void => {
        const trimmed = text.trim();
        let value: unknown;
        if (trimmed.startsWith('{')) {
            try {
                value = JSON.parse(trimmed);
            } catch {
                // a line of something else (a pretty-printed object, text): kept below
            }
        }
        if (isObject(value) && typeof value.type === 'string') {
            if (value.type === 'result') result = resultEvent(value) ?? result;
            onEvent(value);
            return;
        }
        if (other.length < MAX_OUTPUT) other += `${text}\n`;
    };

    return {
        push(chunk) {
            let rest = chunk;
            for (let nl = rest.indexOf('\n'); nl >= 0; nl = rest.indexOf('\n')) {
                if (!skipping) take(line + rest.slice(0, nl));
                line = '';
                skipping = false;
                rest = rest.slice(nl + 1);
            }
            if (skipping) return;
            line += rest;
            if (line.length > MAX_OUTPUT) {
                line = '';
                skipping = true;
            }
        },
        end() {
            if (!skipping) take(line);
            line = '';
            return result ?? resultOf(other);
        },
    };
}
