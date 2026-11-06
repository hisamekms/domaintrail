// A stand-in for `claude` in the subscriber's tests (no real agent runs there): it reads the prompt from stdin, logs
// its invocation and follows the next step of a plan, a JSON file whose path is its first argument:
//
//   { "runs": [ { "edits": [{ "path": "a.dtes", "replace": ["from", "to"] } | { "path", "append" } | { "path", "write" }],
//                 "delayMs": 0, "hang": false, "exitCode": 0, "outcome": { "outcome": "done", "summary": "…" },
//                 "reply": { "outcome": "done", "summary": "…", "requests": [{ "request": 1, "status": "done" }] },
//                 "mcp": { "tool": "knowledge_for_element", "arguments": { … } } }, … ] }
//
// With `mcp` (a cold run), it starts the MCP server `domaintrail` of its `--mcp-config` as Claude Code does (the
// command in its own working directory), calls the tool after `initialize`, and logs the call's result as `mcp`.
//
// Step n is used by the n-th invocation (counted in `<plan>.log`, one JSON line per invocation: pid, the pid of a
// child it started when hanging, the arguments, the working directory and the prompt). It prints the last line of what
// `claude --print --output-format stream-json` prints: one JSON result event, with `reply` as its structured output (as
// `--json-schema` gives it), else with the former outcome line at the end of its `result`.
//
// With `--input-format stream-json` (a warm agent) it stays: each `user` message on stdin is one invocation (a turn,
// logged as above with the same pid), answered with `system/init`, a hook's notification and the result event (an
// `exitCode` other than 0 gives an error result); a hanging turn ends on the `interrupt` control request (its child
// killed); the process exits at the end of its input.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

/** Calls `call.tool` of the `domaintrail` server of `--mcp-config`: the call's result, or why there is none. */
async function callMcp(args, call) {
    const at = args.indexOf('--mcp-config');
    if (at < 0) return { error: 'no --mcp-config' };
    const server = JSON.parse(args[at + 1]).mcpServers?.domaintrail;
    if (!server) return { error: 'no domaintrail server' };
    const child = spawn(server.command, server.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...server.env } });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ask = async (id, method, params) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return JSON.parse((await lines.next()).value);
    };
    await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const answer = await ask(2, 'tools/call', { name: call.tool, arguments: call.arguments ?? {} });
    child.stdin.end();
    await new Promise((resolve) => child.on('exit', resolve));
    return answer.result ?? answer;
}

const [planFile, ...args] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const logFile = `${planFile}.log`;
const nextStep = () => {
    const n = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
    return plan.runs[n] ?? plan.runs.at(-1) ?? {};
};
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function edit(step) {
    for (const edit of step.edits ?? []) {
        const file = path.join(process.cwd(), edit.path);
        if (edit.write !== undefined) writeFileSync(file, edit.write);
        else if (edit.append !== undefined) appendFileSync(file, edit.append);
        else {
            const text = readFileSync(file, 'utf8');
            if (!text.includes(edit.replace[0])) throw new Error(`${edit.path} has no ${edit.replace[0]}`);
            writeFileSync(file, text.replace(edit.replace[0], edit.replace[1]));
        }
    }
}

function resultOf(step, subtype) {
    const isError = subtype !== 'success';
    if (step.reply !== undefined) {
        // what `--json-schema` gives: the reply as `structured_output`, and as JSON in `result`
        return { type: 'result', subtype, is_error: isError, result: JSON.stringify(step.reply), structured_output: step.reply };
    }
    const outcome = step.outcome ?? { outcome: 'done', summary: 'Done.' };
    return { type: 'result', subtype, is_error: isError, result: `I read the files and made the changes.\nDT-OUTCOME: ${JSON.stringify(outcome)}` };
}

if (args.includes('--input-format')) {
    // warm: one turn per user message
    let interrupt = () => {};
    let busy = Promise.resolve();
    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
            print({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
            interrupt();
            return;
        }
        if (message.type === 'user') busy = busy.then(() => turn(message.message.content));
    });
    lines.on('close', () => void busy.then(() => process.exit(0)));
    async function turn(prompt) {
        const step = nextStep();
        print({ type: 'system', subtype: 'init', session_id: 'fake' });
        const child = step.hang ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : undefined;
        appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, childPid: child?.pid, args, cwd: process.cwd(), prompt })}\n`);
        edit(step);
        if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        if (step.hang) {
            await new Promise((resolve) => (interrupt = resolve));
            child.kill('SIGKILL');
            print({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
            return;
        }
        print({ type: 'system', subtype: 'notification', key: 'stop-hook-error', text: 'Stop hook error occurred' });
        print(resultOf(step, (step.exitCode ?? 0) ? 'error_during_execution' : 'success'));
    }
} else {
    const step = nextStep();
    let prompt = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) prompt += chunk;

    const mcp = step.mcp ? await callMcp(args, step.mcp) : undefined;
    const child = step.hang ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : undefined;
    appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, childPid: child?.pid, args, cwd: process.cwd(), prompt, ...(mcp && { mcp }) })}\n`);
    edit(step);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step.hang) await new Promise(() => setInterval(() => {}, 1000));

    const exitCode = step.exitCode ?? 0;
    print(resultOf(step, exitCode ? 'error_during_execution' : 'success'));
    process.exit(exitCode);
}
