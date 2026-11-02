// A stand-in for `claude` in the warm runner's tests: with `--input-format stream-json` it speaks the CLI's
// stream-json protocol, one turn per `user` line on stdin; without, it reads the whole prompt and answers once (a cold
// run). Each turn (or cold run) follows the next step of a plan, a JSON file whose path is its first argument, and is
// logged in `<plan>.log` (one JSON line: pid, the arguments, the prompt). A step:
//
//   { "reply": {…},             the structured output (default: a plain done reply)
//     "error": true,            an error result (`error_during_execution`)
//     "context": 1000,          the context tokens of its model call (in the assistant message's usage)
//     "hang": true,             waits for the interrupt control request (then an error result)
//     "deaf": true,             with hang: ignores the interrupt
//     "crash": 3,               exits with this code after the turn's first events
//     "mute": true,             says nothing at all for this turn
//     "die": 4,                 exits with this code at once, before any event of the turn
//     "ask": true }             sends a control request of its own before the result
//
// Every turn prints `system/init`, a hook's `notification` (as a user's Stop hook does) and an assistant message
// with a tool call, then its result.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [planFile, ...args] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const logFile = `${planFile}.log`;
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const DONE = { outcome: 'done', title: 'T', summary: 'Done.', requests: [] };

const nextStep = (prompt) => {
    const n = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
    appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, args, prompt })}\n`);
    return plan.runs[n] ?? plan.runs.at(-1) ?? {};
};

const result = (step, isError) => {
    const reply = step.reply ?? DONE;
    return isError
        ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }
        : { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(reply), structured_output: reply };
};

if (!args.includes('--input-format')) {
    let prompt = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) prompt += chunk;
    const step = nextStep(prompt);
    print(result(step, step.error === true));
    process.exit(step.error ? 1 : 0);
}

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
    const step = nextStep(prompt);
    if (step.die !== undefined) process.exit(step.die);
    if (step.mute) return;
    print({ type: 'system', subtype: 'init', session_id: 'fake' });
    print({
        type: 'assistant',
        message: {
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.dt' } }],
            usage: { input_tokens: 2, cache_read_input_tokens: step.context ?? 1000, cache_creation_input_tokens: 10 },
        },
    });
    if (step.crash !== undefined) process.exit(step.crash);
    if (step.ask) print({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    if (step.hang) {
        await new Promise((resolve) => (interrupt = step.deaf ? () => {} : resolve));
        print(result(step, true));
        return;
    }
    print({ type: 'system', subtype: 'notification', key: 'stop-hook-error', text: 'Stop hook error occurred' });
    print(result(step, step.error === true));
}
