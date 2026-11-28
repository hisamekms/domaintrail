// Scoring of the Phase 2 AI syntax trial (docs/plans/formal-verification/trial/README.md, protocol 7–10).
//
//   bun scripts/trial/score.ts prepare <run-dir>   normalized dumps and comment-free generated code, under blind labels
//   bun scripts/trial/score.ts map <run-dir>       blind scenario mapping of each label to its generated contracts
//   bun scripts/trial/score.ts review <run-dir>    two blind reviewers per label; a third on every disagreement
//   bun scripts/trial/score.ts report <run-dir>    attempt records (results.json) and the pairwise analysis
//
// Reviewers and mappers see a random label, the task's hidden checklist and scenarios, and the attempt's normalized
// dump (no source text, spans, comments or docs) or generated code without comments — never the arm, the model or the
// token counts. Each step is resumable: a label's output that exists is kept.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';

const REPO = path.join(import.meta.dir, '..', '..');
const TASKS_MD = path.join(REPO, 'docs', 'plans', 'formal-verification', 'trial', 'tasks.md');
const ARMS = ['A0', 'M2', 'M3', 'Q2'] as const;
type ArmName = (typeof ARMS)[number];
const TIMEOUT_MS = 15 * 60_000;

const REVIEWERS = {
    r1: { family: 'Claude', model: 'claude-sonnet-5-5' },
    r2: { family: 'Codex', model: 'gpt-6.2-sol' },
    r3: { family: 'Claude', model: 'claude-opus-5-5' },
    mapper: { family: 'Claude', model: 'claude-sonnet-5-5' },
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const field = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? Object.entries(v).find(([k]) => k === key)?.[1] : undefined);
const str = (v: unknown, key: string): string | undefined => {
    const x = field(v, key);
    return typeof x === 'string' ? x : undefined;
};
const num = (v: unknown, key: string): number => {
    const x = field(v, key);
    return typeof x === 'number' ? x : 0;
};
const parse = (text: string): unknown => {
    try {
        const v: unknown = JSON.parse(text);
        return v;
    } catch {
        return undefined;
    }
};
const readJson = async (file: string): Promise<unknown> => parse(await readFile(file, 'utf8'));
const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));

/** The text of a task packet's section (`### Normalized semantic checklist`, `### Scenario tests`). */
async function section(task: string, heading: string): Promise<string> {
    const md = await readFile(TASKS_MD, 'utf8');
    const at = md.indexOf(`## ${task} `);
    const s = md.indexOf(`### ${heading}`, at);
    const next = [md.indexOf('\n### ', s + 5), md.indexOf('\n## ', s + 5)].filter((x) => x > 0);
    return md.slice(s + `### ${heading}`.length, next.length ? Math.min(...next) : undefined).trim();
}

/** A model without what tells the spelling apart: source text, spans, locations, comments and docs. */
function normalized(v: unknown): unknown {
    const drop = new Set(['text', 'expression', 'location', 'source', 'site', 'span', 'spans', 'line', 'column', 'endLine', 'endColumn', 'doc', 'file', 'at']);
    if (Array.isArray(v)) return v.map(normalized);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (drop.has(k) || k.endsWith('At') ? [] : [[k, normalized(x)]])));
}

/** Code without its comments (JSDoc carries the DSL text of each declaration). */
const withoutComments = (code: string): string =>
    code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\n{3,}/g, '\n\n');

interface Attempt {
    readonly id: string;
    readonly family: 'Claude' | 'Codex';
    readonly model: string;
    readonly arm: ArmName;
    readonly task: string;
    readonly attempt_number: number;
    readonly final_errors: number;
    readonly first_syntax_check_success: 0 | 1;
    readonly first_type_check_success: 0 | 1;
    readonly repair_count: number;
    readonly repair_success_from_diagnostics: 0 | 1 | null;
    readonly exhausted: boolean;
    readonly tokens: { first_input: number; first_output: number; repair_input: number; repair_output: number };
}

const isAttempt = (v: unknown): v is Attempt => typeof str(v, 'id') === 'string' && typeof str(v, 'arm') === 'string' && typeof field(v, 'tokens') === 'object';

async function attempts(dir: string): Promise<Attempt[]> {
    const out: Attempt[] = [];
    for (const id of (await readdir(path.join(dir, 'attempts'))).sort()) {
        const v = await readJson(path.join(dir, 'attempts', id, 'attempt.json')).catch(() => undefined);
        if (isAttempt(v)) out.push(v);
    }
    return out;
}

const runOf = async (dir: string) => {
    const v = await readJson(path.join(dir, 'run.json'));
    const build = field(v, 'build');
    const dt = str(build, 'dt');
    if (!dt) throw new Error(`${dir}/run.json has no build`);
    return { run: v, dt, guideFiles: field(v, 'guide_files') };
};

/** Labels: one random-looking, stable name per attempt, kept apart from the reviewers' inputs. */
const labelOf = (runId: string, id: string) => `L${sha256(`${runId}:${id}`).slice(0, 10)}`;

async function prepare(dir: string): Promise<void> {
    const { run, dt, guideFiles } = await runOf(dir);
    const runId = str(run, 'run_id') ?? '';
    const labels: Record<string, string> = {};
    for (const a of await attempts(dir)) {
        const label = labelOf(runId, a.id);
        labels[label] = a.id;
        const out = path.join(dir, 'review', label);
        if (await exists(path.join(out, 'input.json'))) continue;
        await mkdir(out, { recursive: true });
        const checks = (await readdir(path.join(dir, 'attempts', a.id, 'harness', 'checks'))).sort();
        const lastModel = await readJson(path.join(dir, 'attempts', a.id, 'harness', 'checks', checks.at(-1)!, 'model.json'));
        const files =
            typeof lastModel === 'object' && lastModel !== null ? Object.entries(lastModel).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
        let dump: unknown = null;
        let generated = '';
        if (a.final_errors === 0 && files.length) {
            // the attempt's final model, analyzed and generated by the frozen build under its arm
            const work = path.join(dir, 'review', '.work', label);
            await rm(work, { recursive: true, force: true });
            await mkdir(work, { recursive: true });
            for (const [f, text] of files) {
                await mkdir(path.dirname(path.join(work, f)), { recursive: true });
                await writeFile(path.join(work, f), text);
            }
            const guide = str(field(guideFiles, a.arm), 'path') ?? '';
            const env = {
                ...process.env,
                DOMAINTRAIL_TRIAL_ARM: a.arm,
                DOMAINTRAIL_TRIAL_GUIDE: guide,
                DOMAINTRAIL_STATE_DIR: path.join(dir, 'review', '.state', label),
            };
            const both = await $`bun ${path.join(import.meta.dir, 'dump.ts')} ${work}`.cwd(REPO).env(env).nothrow().quiet();
            const parsed = parse(both.stdout.toString());
            dump = { model: normalized(field(parsed, 'model')), semanticIR: normalized(field(parsed, 'semanticIR')) };
            await $`node ${dt} generate ts --out gen`.cwd(work).env(env).nothrow().quiet();
            const gen = await readdir(path.join(work, 'gen')).catch(() => []);
            for (const f of gen.filter((x) => x.endsWith('.ts') && !x.startsWith('_')).sort())
                generated += `// ${f}\n${withoutComments(await readFile(path.join(work, 'gen', f), 'utf8'))}\n`;
        }
        // the reviewers' inputs must not tell the arm: no spelling of one arm left in them
        const seen = JSON.stringify(dump) + generated;
        for (const t of ['when {', '.with({', 'exhaustive', 'forall', '.exists(', '} =>'])
            if (seen.includes(t)) console.warn(`${label} (${a.id}): its review input contains '${t}'`);
        await writeFile(
            path.join(out, 'input.json'),
            `${JSON.stringify({ label, task: a.task, checks_clean: a.final_errors === 0, checklist: await section(a.task, 'Normalized semantic checklist'), scenarios: await section(a.task, 'Scenario tests'), dump, generated }, null, 2)}\n`,
        );
    }
    await writeFile(path.join(dir, 'review', 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`);
    console.log(`${Object.keys(labels).length} labels prepared`);
}

/** Asks a model once, without tools, in an empty directory; its last message. */
async function ask(who: keyof typeof REVIEWERS, prompt: string, cwd: string): Promise<string> {
    const r = REVIEWERS[who];
    await mkdir(cwd, { recursive: true });
    const cmd =
        r.family === 'Claude'
            ? [
                  'claude',
                  '-p',
                  '--model',
                  r.model,
                  '--output-format',
                  'json',
                  '--setting-sources',
                  'project',
                  '--strict-mcp-config',
                  '--no-session-persistence',
                  '--disallowedTools',
                  'Bash',
                  'Read',
                  'Write',
                  'Edit',
                  'Glob',
                  'Grep',
                  'WebFetch',
                  'WebSearch',
                  'Task',
                  'Agent',
                  'NotebookEdit',
              ]
            : [
                  'codex',
                  'exec',
                  '--json',
                  '--ignore-user-config',
                  '--ignore-rules',
                  '--ephemeral',
                  '--skip-git-repo-check',
                  '-m',
                  r.model,
                  '-c',
                  'model_reasoning_effort="medium"',
                  '-s',
                  'read-only',
                  '-C',
                  cwd,
                  '-',
              ];
    const p = Bun.spawn(cmd, { cwd, stdin: new TextEncoder().encode(prompt), stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    if (r.family === 'Claude') return str(parse(out), 'result') ?? '';
    let last = '';
    for (const line of out.split('\n')) {
        const e = parse(line);
        const item = field(e, 'item');
        if (str(e, 'type') === 'item.completed' && str(item, 'type') === 'agent_message') last = str(item, 'text') ?? last;
    }
    return last;
}

/** The JSON object in a reply (a fenced block, or the whole text). */
function jsonOf(reply: string): unknown {
    const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(reply)?.[1];
    return parse(fenced ?? reply) ?? parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
}

async function eachLabel(dir: string, parallel: number, f: (label: string, input: unknown) => Promise<void>): Promise<void> {
    const labels = (await readdir(path.join(dir, 'review'))).filter((l) => l.startsWith('L')).sort();
    const queue = [...labels];
    await Promise.all(
        Array.from({ length: parallel }, async () => {
            for (let l = queue.shift(); l; l = queue.shift()) {
                const input = await readJson(path.join(dir, 'review', l, 'input.json'));
                await f(l, input).catch((e: unknown) => console.error(`${l}: ${String(e)}`));
            }
        }),
    );
}

const MAP_PROMPT = (
    input: unknown,
) => `You map business scenarios to generated TypeScript domain contracts. The contracts were generated from a domain model of the requirements below; their comments are removed. For each scenario, name the generated declarations (types, decide/requirement functions, checks) that decide it, and say whether a correct implementation of these contracts would give the expected outcome: "pass" (the contracts give it), "fail" (they contradict it or cannot express it) or "uncertain" (they leave it open). Judge only what the contracts state, with two conventions: a typed value in a scenario (\`TeamId("T1")\`, \`Week(2026-W20)\`) stands for a valid value of the model's matching type, whatever its format; and the contracts give the types of the fields an outcome sets but not yet their values, so a scenario that depends only on a value they leave typed is "uncertain", not "fail".

Scenarios:
${str(input, 'scenarios')}

Generated contracts:
\`\`\`ts
${str(input, 'generated')}
\`\`\`

Reply with one JSON object only: {"scenarios": [{"scenario": "<the input sequence>", "declarations": ["…"], "outcome": "pass" | "fail" | "uncertain", "rationale": "…"}]}`;

async function map(dir: string, parallel: number): Promise<void> {
    await eachLabel(dir, parallel, async (label, input) => {
        const out = path.join(dir, 'review', label, 'mapping.json');
        if (await exists(out)) return;
        if (field(input, 'checks_clean') !== true) {
            await writeFile(out, `${JSON.stringify({ reviewer: 'none', scenarios: [], note: 'the model does not check: no contracts' }, null, 2)}\n`);
            return;
        }
        const reply = await ask('mapper', MAP_PROMPT(input), path.join(dir, 'review', '.ask', `${label}-map`));
        await writeFile(out, `${JSON.stringify({ reviewer: REVIEWERS.mapper, reply: jsonOf(reply) ?? reply }, null, 2)}\n`);
        console.log(`${label}: mapped`);
    });
}

const REVIEW_PROMPT = (
    input: unknown,
    mapping: unknown,
) => `You review a domain model against a hidden checklist. The model is given as a normalized dump (its Typed Model and Semantic IR, with source text, positions, comments and docs removed), with the outcomes of the business scenarios mapped onto its generated contracts. Decide whether the model has the meaning the checklist states. Judge meaning, not names or style: a fact may be modelled in any equivalent way.

Checklist:
${str(input, 'checklist')}

Scenario outcomes on the generated contracts:
${JSON.stringify(field(field(mapping, 'reply'), 'scenarios') ?? [], null, 2)}

Normalized dump:
\`\`\`json
${JSON.stringify(field(input, 'dump'))}
\`\`\`

Reply with one JSON object only: {"verdict": "pass" | "fail" | "uncertain", "items": [{"item": "<checklist item>", "met": "yes" | "no" | "unclear", "rationale": "…"}]}. "pass" only when every item is met.`;

const ADJUDICATE_PROMPT = (input: unknown, mapping: unknown, a: unknown, b: unknown) => `${REVIEW_PROMPT(input, mapping)}

Two reviewers disagreed. Reviewer A: ${JSON.stringify(a)}
Reviewer B: ${JSON.stringify(b)}
Decide yourself, item by item, and give the final verdict in the same JSON form.`;

const verdictOf = (v: unknown): 'pass' | 'fail' | 'uncertain' | undefined => {
    const x = str(field(v, 'reply'), 'verdict');
    return x === 'pass' || x === 'fail' || x === 'uncertain' ? x : undefined;
};

async function review(dir: string, parallel: number): Promise<void> {
    await eachLabel(dir, parallel, async (label, input) => {
        const base = path.join(dir, 'review', label);
        if (field(input, 'checks_clean') !== true) {
            for (const r of ['r1', 'r2'] as const)
                if (!(await exists(path.join(base, `${r}.json`))))
                    await writeFile(
                        path.join(base, `${r}.json`),
                        `${JSON.stringify({ reviewer: 'none', reply: { verdict: 'fail', items: [], rationale: 'the model does not check' } }, null, 2)}\n`,
                    );
            return;
        }
        const mapping = await readJson(path.join(base, 'mapping.json'));
        for (const r of ['r1', 'r2'] as const) {
            const out = path.join(base, `${r}.json`);
            if (await exists(out)) continue;
            const reply = await ask(r, REVIEW_PROMPT(input, mapping), path.join(dir, 'review', '.ask', `${label}-${r}`));
            await writeFile(out, `${JSON.stringify({ reviewer: REVIEWERS[r], reply: jsonOf(reply) ?? reply }, null, 2)}\n`);
        }
        const v1 = await readJson(path.join(base, 'r1.json'));
        const v2 = await readJson(path.join(base, 'r2.json'));
        const out = path.join(base, 'r3.json');
        if (verdictOf(v1) !== verdictOf(v2) && !(await exists(out))) {
            const reply = await ask(
                'r3',
                ADJUDICATE_PROMPT(input, mapping, field(v1, 'reply'), field(v2, 'reply')),
                path.join(dir, 'review', '.ask', `${label}-r3`),
            );
            await writeFile(out, `${JSON.stringify({ reviewer: REVIEWERS.r3, reply: jsonOf(reply) ?? reply }, null, 2)}\n`);
        }
        console.log(`${label}: reviewed`);
    });
}

/** A mean and a percentile-bootstrap 95% interval of the per-unit values. */
function interval(values: readonly number[], seed = 1): { mean: number; lo: number; hi: number; n: number } {
    if (!values.length) return { mean: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 };
    let a = seed;
    const rnd = () => {
        a = (a * 1103515245 + 12345) % 2147483648;
        return a / 2147483648;
    };
    const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const means = Array.from({ length: 2000 }, () => mean(values.map(() => values[Math.floor(rnd() * values.length)]!))).sort((x, y) => x - y);
    return { mean: mean(values), lo: means[50]!, hi: means[1949]!, n: values.length };
}

async function report(dir: string): Promise<void> {
    const { run } = await runOf(dir);
    const runId = str(run, 'run_id') ?? '';
    const all = await attempts(dir);
    const rows: Record<string, unknown>[] = [];
    for (const a of all) {
        const base = path.join(dir, 'review', labelOf(runId, a.id));
        const v1 = await readJson(path.join(base, 'r1.json')).catch(() => undefined);
        const v2 = await readJson(path.join(base, 'r2.json')).catch(() => undefined);
        const v3 = await readJson(path.join(base, 'r3.json')).catch(() => undefined);
        const adjudicated = verdictOf(v1) === verdictOf(v2) ? verdictOf(v1) : verdictOf(v3);
        rows.push({
            ...a,
            label: labelOf(runId, a.id),
            reviewer_1_verdict: verdictOf(v1),
            reviewer_2_verdict: verdictOf(v2),
            adjudication_required: verdictOf(v1) !== verdictOf(v2),
            adjudicated_verdict: adjudicated,
        });
    }
    await writeFile(path.join(dir, 'results.json'), `${JSON.stringify(rows, null, 2)}\n`);
    const tasks = [...new Set(all.map((a) => a.task))].sort();
    const families = ['Claude', 'Codex'] as const;
    const rate = (xs: readonly Record<string, unknown>[], key: string) => (xs.length ? xs.reduce((s, x) => s + num(x, key), 0) / xs.length : Number.NaN);
    const repairTokens = (xs: readonly Record<string, unknown>[]) =>
        xs.length ? xs.reduce((s, x) => s + num(field(x, 'tokens'), 'repair_input') + num(field(x, 'tokens'), 'repair_output'), 0) / xs.length : Number.NaN;
    const semanticPass = (xs: readonly Record<string, unknown>[]) =>
        xs.length ? xs.filter((x) => field(x, 'adjudicated_verdict') === 'pass').length / xs.length : Number.NaN;
    const pp = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(0)}%`);
    const lines: string[] = [`# Trial analysis: ${runId}`, '', `Attempts: ${all.length}. Exhausted: ${all.filter((a) => a.exhausted).length}.`, ''];
    const agreement = rows.filter((r) => field(r, 'reviewer_1_verdict') && field(r, 'reviewer_1_verdict') === field(r, 'reviewer_2_verdict')).length;
    lines.push(`Reviewer agreement: ${agreement}/${rows.length}; adjudicated: ${rows.filter((r) => field(r, 'adjudication_required') === true).length}.`, '');
    const decisions: string[] = [];
    for (const arm of ['M2', 'M3', 'Q2'] as const) {
        lines.push(
            `## ${arm} vs A0`,
            '',
            '| Packet | Family | n (arm/A0) | First syntax | First type | Repair tokens / attempt | Semantic pass |',
            '|---|---|---|---|---|---|---|',
        );
        let wins = 0;
        let regressionAnywhere = false;
        let veto = false;
        const pairs: number[] = [];
        for (const task of tasks) {
            const of = (x: string, fam?: string) =>
                rows.filter((r) => field(r, 'arm') === x && field(r, 'task') === task && (!fam || field(r, 'family') === fam));
            const sDiff = rate(of(arm), 'first_syntax_check_success') - rate(of('A0'), 'first_syntax_check_success');
            const tDiff = rate(of(arm), 'first_type_check_success') - rate(of('A0'), 'first_type_check_success');
            let tokensBetter = true;
            let tokensWorse = false;
            let reversed = false;
            for (const fam of families) {
                const ra = repairTokens(of(arm, fam));
                const rb = repairTokens(of('A0', fam));
                const ratio = rb > 0 ? ra / rb : ra > 0 ? Infinity : 1;
                if (!(ratio <= 0.85)) tokensBetter = false;
                if (ratio >= 1.15) tokensWorse = true;
                const fs = rate(of(arm, fam), 'first_syntax_check_success') - rate(of('A0', fam), 'first_syntax_check_success');
                const ft = rate(of(arm, fam), 'first_type_check_success') - rate(of('A0', fam), 'first_type_check_success');
                if ((sDiff > 0 && fs < 0) || (sDiff < 0 && fs > 0) || (tDiff > 0 && ft < 0) || (tDiff < 0 && ft > 0)) reversed = true;
                lines.push(
                    `| ${task} | ${fam} | ${of(arm, fam).length}/${of('A0', fam).length} | ${pp(rate(of(arm, fam), 'first_syntax_check_success'))} vs ${pp(rate(of('A0', fam), 'first_syntax_check_success'))} | ${pp(rate(of(arm, fam), 'first_type_check_success'))} vs ${pp(rate(of('A0', fam), 'first_type_check_success'))} | ${ra.toFixed(0)} vs ${rb.toFixed(0)} | ${pp(semanticPass(of(arm, fam)))} vs ${pp(semanticPass(of('A0', fam)))} |`,
                );
            }
            const improves = sDiff >= 0.1 || tDiff >= 0.1 || tokensBetter;
            const regresses = sDiff <= -0.1 || tDiff <= -0.1 || tokensWorse;
            if (regresses) regressionAnywhere = true;
            if (improves && !regresses && !reversed) wins++;
            if (semanticPass(of(arm)) <= semanticPass(of('A0')) - 0.1) veto = true;
            pairs.push(tDiff);
            lines.push(
                `| ${task} | pooled | ${of(arm).length}/${of('A0').length} | ${pp(sDiff)} pts | ${pp(tDiff)} pts | ${tokensBetter ? '≥15% fewer (both)' : tokensWorse ? '≥15% more (a family)' : 'within 15%'} | ${pp(semanticPass(of(arm)))} vs ${pp(semanticPass(of('A0')))} |`,
            );
        }
        const ci = interval(pairs);
        const beats = wins >= 2 && !regressionAnywhere && !veto;
        decisions.push(
            `- ${arm}: ${beats ? 'beats A0' : 'does not beat A0'} (packets improved without regression or reversal: ${wins}; a regression in some packet: ${regressionAnywhere ? 'yes' : 'no'}; semantic veto: ${veto ? 'yes' : 'no'}).`,
        );
        lines.push('', `Mean first type-check difference over packets: ${pp(ci.mean)} pts (95% bootstrap ${pp(ci.lo)} to ${pp(ci.hi)}, n=${ci.n}).`, '');
    }
    lines.push(
        '## Decision',
        '',
        ...decisions,
        '',
        decisions.some((d) => d.includes('beats A0')) ? 'An arm met the decision rule.' : 'No arm met the decision rule: A0 stays adopted.',
        '',
    );
    await writeFile(path.join(dir, 'analysis.md'), `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
}

if (import.meta.main) {
    const [cmd, dir, ...rest] = process.argv.slice(2);
    const i = rest.indexOf('--parallel');
    const parallel = i >= 0 ? Number(rest[i + 1]) : 3;
    if (!dir) throw new Error('usage: bun scripts/trial/score.ts prepare|map|review|report <run-dir>');
    if (cmd === 'prepare') await prepare(dir);
    else if (cmd === 'map') await map(dir, parallel);
    else if (cmd === 'review') await review(dir, parallel);
    else if (cmd === 'report') await report(dir);
    else throw new Error(`unknown command ${cmd}`);
}
