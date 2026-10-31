// A stand-in for `claude` in the subscriber's tests (no real agent runs there): it reads the prompt from stdin, logs
// its invocation and follows the next step of a plan, a JSON file whose path is its first argument:
//
//   { "runs": [ { "edits": [{ "path": "a.dtes", "replace": ["from", "to"] } | { "path", "append" } | { "path", "write" }],
//                 "delayMs": 0, "hang": false, "exitCode": 0, "outcome": { "outcome": "done", "summary": "…" } }, … ] }
//
// Step n is used by the n-th invocation (counted in `<plan>.log`, one JSON line per invocation: pid, the pid of a
// child it started when hanging, the arguments, the working directory and the prompt). It prints what
// `claude --print --output-format json` prints: one JSON result whose `result` ends with the outcome line.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const [planFile, ...args] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const logFile = `${planFile}.log`;
const n = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
const step = plan.runs[n] ?? plan.runs.at(-1) ?? {};

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const child = step.hang ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : undefined;
appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, childPid: child?.pid, args, cwd: process.cwd(), prompt })}\n`);

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
if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
if (step.hang) await new Promise(() => setInterval(() => {}, 1000));

const outcome = step.outcome ?? { outcome: 'done', summary: 'Done.' };
const exitCode = step.exitCode ?? 0;
const result = `I read the files and made the changes.\nDT-OUTCOME: ${JSON.stringify(outcome)}`;
process.stdout.write(`${JSON.stringify({ type: 'result', subtype: exitCode ? 'error_during_execution' : 'success', is_error: exitCode !== 0, result })}\n`);
process.exit(exitCode);
