// The harness of the Phase 2 AI syntax trial (docs/plans/formal-verification/trial/README.md).
//
//   bun scripts/trial/run.ts init <run-dir> --phase pilot|main [--seed N]   freeze the build, guides, packets, prompts
//   bun scripts/trial/run.ts run <run-dir> [--parallel N] [--only ID,…]      run the pending attempts (resumable)
//   bun scripts/trial/run.ts status <run-dir>
//
// An attempt is one task packet for one arm and one model, in a fresh session in an empty directory outside any
// repository. Turn 1 gives the business requirements and `dt guide` (the arm's guide; `dt guide` is the only command);
// the harness then runs `dt check` and, while it reports errors, sends its report in a new turn of the same session
// (the documented repair loop, at most MAX_REPAIRS turns). Every model, report and turn's token use is kept.
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, symlink, writeFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import { renderArmGuides, type Arm } from '../trial-guides.js';

const REPO = path.join(import.meta.dir, '..', '..');
const TRIAL_DOCS = path.join(REPO, 'docs', 'plans', 'formal-verification', 'trial');
const MAX_REPAIRS = 5;
const TURN_TIMEOUT_MS = 20 * 60_000;
const ARMS: readonly Arm[] = ['A0', 'M2', 'M3', 'Q2'];
const TASKS = ['WS-01', 'WS-02', 'WS-03', 'WS-04'] as const;
type Family = 'Claude' | 'Codex';

const MODELS: Record<Family, { id: string; version: string; settings: Record<string, unknown> }> = {
    Claude: {
        id: 'claude-sonnet-5-5',
        version: 'claude-sonnet-5-5 via Claude Code (claude -p)',
        settings: { cli: 'claude -p', setting_sources: 'project', strict_mcp_config: true, tools: 'Read Write Edit Glob Grep Bash(dt guide:*) Bash(ls:*)' },
    },
    Codex: {
        id: 'gpt-6.2-sol',
        version: 'gpt-6.2-sol via Codex CLI (codex exec)',
        settings: { cli: 'codex exec', model_reasoning_effort: 'medium', sandbox: 'workspace-write', ignore_user_config: true, ignore_rules: true },
    },
};

export const PROMPT_VERSION = '1';
export const FIRST_PROMPT = `You are writing a domain model in DomainTrail, a domain modeling language. The business requirements are in REQUIREMENTS.md in this directory.

Learn the language with the \`dt guide\` command: \`dt guide\` prints a quick reference and the list of topics, and \`dt guide <topic>\` prints one topic. It is the only documentation: do not look for other DomainTrail files, examples or documentation outside this directory.

Write the model as one or more \`.dt\` files in this directory, modelling every requirement. You cannot run the checker yourself: when the model is written, reply with DONE. If the checker finds problems, its report will be sent to you.`;
export const repairPrompt = (report: string) => `\`dt check\` reported these problems in your model:

${report.trim()}

Fix the model in this directory so that \`dt check\` reports no errors, keeping it faithful to the requirements. Reply with DONE when the files are updated.`;

interface Scheduled {
    readonly id: string;
    readonly family: Family;
    readonly arm: Arm;
    readonly task: (typeof TASKS)[number];
    readonly attempt_number: number;
    readonly order: number;
}

interface Run {
    readonly run_id: string;
    readonly phase: 'pilot' | 'main';
    readonly created_at: string;
    readonly seed: number;
    readonly build: { commit: string; dist_sha256: string; lockfile_sha256: string; dt: string };
    readonly guides: unknown;
    readonly guide_files: Record<Arm, { path: string; sha256: string; changedLines: number[] }>;
    readonly guide_template_version: string;
    readonly packet: { version: string; sha256: string; requirements: Record<string, string> };
    readonly prompt: { version: string; first: string; repair: string };
    readonly models: typeof MODELS;
    readonly pinned_at: string;
    readonly max_repairs: number;
    readonly schedule: Scheduled[];
}

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Reading JSON the CLIs and dt print: a field of an object, or undefined. */
const field = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? Object.entries(v).find(([k]) => k === key)?.[1] : undefined);
const num = (v: unknown, key: string): number => {
    const x = field(v, key);
    return typeof x === 'number' ? x : 0;
};
const str = (v: unknown, key: string): string | undefined => {
    const x = field(v, key);
    return typeof x === 'string' ? x : undefined;
};
const parse = (text: string): unknown => {
    try {
        const v: unknown = JSON.parse(text);
        return v;
    } catch {
        return undefined;
    }
};
const isRun = (v: unknown): v is Run => Array.isArray(field(v, 'schedule')) && typeof field(v, 'run_id') === 'string';
async function readRun(dir: string): Promise<Run> {
    const v = parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
    if (!isRun(v)) throw new Error(`${dir}/run.json is not a run`);
    return v;
}

/** A small seeded generator (mulberry32), so that a run's order is reproducible from its seed. */
function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function shuffle<T>(xs: T[], rnd: () => number): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
}

/** The business requirements of each task packet: the text under its `### Business requirements` heading. */
function requirementsOf(tasks: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of TASKS) {
        const at = tasks.indexOf(`## ${id} `);
        const req = tasks.indexOf('### Business requirements', at);
        const end = tasks.indexOf('\n### ', req + 10);
        if (at < 0 || req < 0 || end < 0) throw new Error(`tasks.md: no business requirements for ${id}`);
        out[id] = tasks.slice(req + '### Business requirements'.length, end).trim();
    }
    return out;
}

/**
 * Attempts per arm and packet, split by family: the main run 6 + 6, the pilot 3 (alternately 2 + 1 and 1 + 2, so the
 * pilot has the main run's even mix of families).
 */
function scheduleOf(phase: 'pilot' | 'main', seed: number): Scheduled[] {
    const rnd = random(seed);
    const blocks: Record<Family, Omit<Scheduled, 'order' | 'id'>[]> = { Claude: [], Codex: [] };
    let k = 0;
    for (const arm of ARMS)
        for (const task of TASKS) {
            const claude = phase === 'main' ? 6 : k % 2 === 0 ? 2 : 1;
            const codex = phase === 'main' ? 6 : 3 - claude;
            k++;
            let n = 0;
            for (let i = 0; i < claude; i++) blocks.Claude.push({ family: 'Claude', arm, task, attempt_number: ++n });
            for (let i = 0; i < codex; i++) blocks.Codex.push({ family: 'Codex', arm, task, attempt_number: ++n });
        }
    // the order is random within each model block (README protocol 5); the two blocks run side by side
    return (['Claude', 'Codex'] as const).flatMap((family) =>
        shuffle(blocks[family], rnd).map((s, i) => ({ ...s, order: i + 1, id: `${phase}-${family.toLowerCase()}-${String(i + 1).padStart(3, '0')}` })),
    );
}

async function init(dir: string, phase: 'pilot' | 'main', seed: number): Promise<void> {
    if (await stat(path.join(dir, 'run.json')).catch(() => undefined)) throw new Error(`${dir} already has a run`);
    await mkdir(path.join(dir, 'build', 'dist'), { recursive: true });
    // the frozen build: this checkout's dist, with its dependencies
    const commit = (await $`git rev-parse HEAD`.cwd(REPO).text()).trim();
    const dirty = (
        await $`git status --porcelain -- contexts apps capabilities platform shared docs/guide.md scripts/trial-guides.ts docs/plans/formal-verification/trial/guide-arms.json docs/plans/formal-verification/trial/tasks.md`
            .cwd(REPO)
            .text()
    ).trim();
    if (dirty) throw new Error(`the build must be of a clean checkout:\n${dirty}`);
    await $`bun run build`.cwd(REPO).quiet();
    await cp(path.join(REPO, 'dist'), path.join(dir, 'build', 'dist'), { recursive: true });
    await symlink(path.join(REPO, 'node_modules'), path.join(dir, 'build', 'node_modules')).catch(() => undefined);
    const dt = path.join(dir, 'build', 'dist', 'dt.js');
    const { guides, manifest } = await renderArmGuides();
    await mkdir(path.join(dir, 'guides'), { recursive: true });
    for (const g of guides) await writeFile(path.join(dir, 'guides', `${g.arm}.md`), g.text);
    await writeFile(path.join(dir, 'guides', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const tasks = await readFile(path.join(TRIAL_DOCS, 'tasks.md'), 'utf8');
    const guideOf = (arm: Arm) => {
        const g = guides.find((x) => x.arm === arm);
        if (!g) throw new Error(`no guide for ${arm}`);
        return { path: path.join(dir, 'guides', `${arm}.md`), sha256: g.sha256, changedLines: g.changedLines };
    };
    const guideFiles: Run['guide_files'] = { A0: guideOf('A0'), M2: guideOf('M2'), M3: guideOf('M3'), Q2: guideOf('Q2') };
    const run: Run = {
        run_id: `${phase}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
        phase,
        created_at: new Date().toISOString(),
        seed,
        build: { commit, dist_sha256: sha256(await readFile(dt)), lockfile_sha256: sha256(await readFile(path.join(REPO, 'bun.lock'))), dt },
        guides: manifest,
        guide_files: guideFiles,
        guide_template_version: '1',
        packet: { version: '1', sha256: sha256(tasks), requirements: requirementsOf(tasks) },
        prompt: { version: PROMPT_VERSION, first: FIRST_PROMPT, repair: repairPrompt('<the text of dt check>') },
        models: MODELS,
        pinned_at: new Date().toISOString(),
        max_repairs: MAX_REPAIRS,
        schedule: scheduleOf(phase, seed),
    };
    await writeFile(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    console.log(`${run.run_id}: ${run.schedule.length} attempts in ${dir}`);
}

interface Usage {
    input: number;
    output: number;
    raw: unknown;
}
interface Turn {
    readonly kind: 'first' | 'repair';
    readonly started_at: string;
    readonly seconds: number;
    readonly exit: number | null;
    readonly timed_out: boolean;
    readonly usage: Usage;
    readonly session?: string;
}
interface Check {
    readonly n: number;
    readonly files: number;
    readonly errors: number;
    readonly syntax_errors: number;
    readonly model_sha256: string;
    readonly report: string;
}

/** Runs a command with a time limit; its stdout, and how it ended. */
async function exec(
    cmd: string[],
    cwd: string,
    env: Record<string, string>,
    stdin?: string,
): Promise<{ out: string; err: string; exit: number | null; timedOut: boolean; seconds: number }> {
    const t0 = Date.now();
    const p = Bun.spawn(cmd, { cwd, env, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        p.kill();
    }, TURN_TIMEOUT_MS);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const exit = await p.exited;
    clearTimeout(timer);
    return { out, err, exit, timedOut, seconds: (Date.now() - t0) / 1000 };
}

/** The `.dt` files of the attempt's directory, by path. */
async function modelFiles(work: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.name.endsWith('.dt')) out[path.relative(work, p)] = await readFile(p, 'utf8');
        }
    };
    await walk(work);
    return out;
}

async function runAttempt(dir: string, run: Run, s: Scheduled): Promise<void> {
    const at = path.join(dir, 'attempts', s.id);
    const done = path.join(at, 'attempt.json');
    if (await stat(done).catch(() => undefined)) return;
    const work = path.join(at, 'work');
    const harness = path.join(at, 'harness');
    await mkdir(work, { recursive: true });
    await mkdir(path.join(harness, 'bin'), { recursive: true });
    await mkdir(path.join(harness, 'checks'), { recursive: true });
    await writeFile(path.join(work, 'REQUIREMENTS.md'), `# Requirements\n\n${run.packet.requirements[s.task]}\n`);
    // `dt` for the agent: the arm's guide only (the harness runs the checks)
    await writeFile(
        path.join(harness, 'bin', 'dt'),
        `#!/bin/sh\ncase "\${1:-}" in\n  guide) exec node "${run.build.dt}" "$@" ;;\n  *) echo "Only 'dt guide' is available in this task; the checker is run for you." >&2; exit 2 ;;\nesac\n`,
        { mode: 0o755 },
    );
    const env: Record<string, string> = {
        PATH: `${path.join(harness, 'bin')}:${process.env['PATH'] ?? ''}`,
        HOME: process.env['HOME'] ?? '',
        DOMAINTRAIL_TRIAL_ARM: s.arm,
        DOMAINTRAIL_TRIAL_GUIDE: run.guide_files[s.arm].path,
        DOMAINTRAIL_STATE_DIR: path.join(harness, 'state'),
        XDG_CACHE_HOME: path.join(harness, 'cache'),
        LANG: 'en_US.UTF-8',
        ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
        ...(process.env['USER'] ? { USER: process.env['USER'] } : {}),
    };
    const turns: Turn[] = [];
    const checks: Check[] = [];
    let session: string | undefined;

    const turn = async (kind: Turn['kind'], prompt: string): Promise<Turn> => {
        const started_at = new Date().toISOString();
        const n = turns.length + 1;
        let cmd: string[];
        if (s.family === 'Claude') {
            cmd = [
                'claude',
                '-p',
                prompt,
                '--model',
                run.models.Claude.id,
                '--output-format',
                'json',
                '--setting-sources',
                'project',
                '--strict-mcp-config',
                '--allowedTools',
                'Read',
                'Write',
                'Edit',
                'Glob',
                'Grep',
                'Bash(dt guide:*)',
                'Bash(ls:*)',
                '--disallowedTools',
                'WebFetch',
                'WebSearch',
                'Task',
                'Agent',
                ...(session ? ['--resume', session] : []),
            ];
        } else {
            const common = [
                '--json',
                '--ignore-user-config',
                '--ignore-rules',
                '--skip-git-repo-check',
                '-m',
                run.models.Codex.id,
                '-c',
                'model_reasoning_effort="medium"',
            ];
            cmd = session
                ? ['codex', 'exec', 'resume', ...common, '-c', 'sandbox_mode="workspace-write"', session, prompt]
                : ['codex', 'exec', ...common, '-s', 'workspace-write', '-C', work, prompt];
        }
        const r = await exec(cmd, work, env);
        await writeFile(path.join(harness, `turn-${n}.out`), r.out);
        await writeFile(path.join(harness, `turn-${n}.err`), r.err);
        let usage: Usage = { input: 0, output: 0, raw: null };
        if (s.family === 'Claude') {
            const j = parse(r.out);
            session = str(j, 'session_id') ?? session;
            const u = field(j, 'usage');
            usage = {
                input: num(u, 'input_tokens') + num(u, 'cache_read_input_tokens') + num(u, 'cache_creation_input_tokens'),
                output: num(u, 'output_tokens'),
                raw: u ?? null,
            };
        } else {
            for (const line of r.out.split('\n')) {
                const e = parse(line);
                const type = str(e, 'type');
                if (type === 'thread.started') session = str(e, 'thread_id') ?? session;
                const u = field(e, 'usage');
                if (type === 'turn.completed' && u)
                    usage = {
                        input: usage.input + num(u, 'input_tokens'),
                        output: usage.output + num(u, 'output_tokens') + num(u, 'reasoning_output_tokens'),
                        raw: u,
                    };
            }
        }
        const t: Turn = { kind, started_at, seconds: r.seconds, exit: r.exit, timed_out: r.timedOut, usage, ...(session ? { session } : {}) };
        turns.push(t);
        return t;
    };

    const check = async (): Promise<Check> => {
        const n = checks.length + 1;
        const cdir = path.join(harness, 'checks', String(n).padStart(2, '0'));
        await mkdir(cdir, { recursive: true });
        const files = await modelFiles(work);
        await writeFile(path.join(cdir, 'model.json'), `${JSON.stringify(files, null, 2)}\n`);
        let report = 'There is no .dt file in this directory.';
        let errors = 1;
        let syntax = 1;
        if (Object.keys(files).length) {
            const text = await exec(['node', run.build.dt, 'check', '--no-knowledge'], work, env);
            const json = await exec(['node', run.build.dt, 'check', '--no-knowledge', '--format', 'json'], work, env);
            await writeFile(path.join(cdir, 'report.txt'), text.out + text.err);
            await writeFile(path.join(cdir, 'diagnostics.json'), json.out);
            const list = field(parse(json.out), 'diagnostics');
            const diagnostics = Array.isArray(list) ? list.map((x: unknown) => ({ severity: str(x, 'severity'), code: str(x, 'code') })) : [];
            errors = diagnostics.filter((x) => x.severity === 'error').length || (Array.isArray(list) ? 0 : 1);
            syntax = diagnostics.filter((x) => x.severity === 'error' && x.code === 'SYNTAX').length;
            report = (text.err + text.out).trim();
        }
        const c: Check = { n, files: Object.keys(files).length, errors, syntax_errors: syntax, model_sha256: sha256(JSON.stringify(files)), report };
        checks.push(c);
        return c;
    };

    await turn('first', FIRST_PROMPT);
    let last = await check();
    while (last.errors > 0 && turns.length <= MAX_REPAIRS && session) {
        const t = await turn('repair', repairPrompt(last.report));
        last = await check();
        if (t.timed_out) break;
    }
    const first = checks[0]!;
    const repairs = turns.filter((t) => t.kind === 'repair');
    // a repair cycle is a changed submission after a report (README protocol 7)
    const changed = checks.slice(1).filter((c, i) => c.model_sha256 !== checks[i]!.model_sha256).length;
    const record = {
        id: s.id,
        run_id: run.run_id,
        phase: run.phase,
        family: s.family,
        model: run.models[s.family].id,
        arm: s.arm,
        task: s.task,
        attempt_number: s.attempt_number,
        order: s.order,
        first_syntax_check_success: first.files > 0 && first.syntax_errors === 0 ? 1 : 0,
        first_type_check_success: first.files > 0 && first.errors === 0 ? 1 : 0,
        final_errors: last.errors,
        repair_turns: repairs.length,
        repair_count: changed,
        repair_success_from_diagnostics: first.errors === 0 ? null : last.errors === 0 ? 1 : 0,
        exhausted: last.errors > 0,
        tokens: {
            first_input: turns[0]!.usage.input,
            first_output: turns[0]!.usage.output,
            repair_input: repairs.reduce((n, t) => n + t.usage.input, 0),
            repair_output: repairs.reduce((n, t) => n + t.usage.output, 0),
        },
        turns,
        checks: checks.map(({ report: _report, ...c }) => c),
        finished_at: new Date().toISOString(),
    };
    await writeFile(done, `${JSON.stringify(record, null, 2)}\n`);
    console.log(
        `${s.id} ${s.family} ${s.arm} ${s.task}: syntax ${record.first_syntax_check_success} type ${record.first_type_check_success} final errors ${last.errors} repairs ${changed}`,
    );
}

async function runAll(dir: string, parallel: number, only?: string[]): Promise<void> {
    const run = await readRun(dir);
    const pending = run.schedule.filter((s) => !only || only.includes(s.id));
    // the two model blocks run side by side, each in its order, `parallel` attempts at a time per block
    await Promise.all(
        (['Claude', 'Codex'] as const).map(async (family) => {
            const queue = pending.filter((s) => s.family === family).sort((a, b) => a.order - b.order);
            const workers = Array.from({ length: parallel }, async () => {
                for (let s = queue.shift(); s; s = queue.shift()) await runAttempt(dir, run, s).catch((e: unknown) => console.error(`${s.id}: ${String(e)}`));
            });
            await Promise.all(workers);
        }),
    );
}

async function status(dir: string): Promise<void> {
    const run = await readRun(dir);
    let done = 0;
    for (const s of run.schedule) if (await stat(path.join(dir, 'attempts', s.id, 'attempt.json')).catch(() => undefined)) done++;
    console.log(`${run.run_id}: ${done}/${run.schedule.length} attempts done`);
}

if (import.meta.main) {
    const [cmd, dir, ...rest] = process.argv.slice(2);
    const opt = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
    };
    if (!dir) throw new Error('usage: bun scripts/trial/run.ts init|run|status <run-dir> …');
    if (cmd === 'init') {
        const phase = opt('--phase');
        if (phase !== 'pilot' && phase !== 'main') throw new Error('--phase pilot|main');
        await init(dir, phase, Number(opt('--seed') ?? Date.now() % 1_000_000));
    } else if (cmd === 'run') await runAll(dir, Number(opt('--parallel') ?? 2), opt('--only')?.split(','));
    else if (cmd === 'status') await status(dir);
    else throw new Error(`unknown command ${cmd}`);
}
