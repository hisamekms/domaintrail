import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { analyze, type Analysis } from '../core/analyze.js';
import { ConfigError, checkTsContexts, loadConfig, staysInside, type ResolvedConfig } from '../core/config.js';
import { formatDiagnostic, jsonDiagnostic, type JsonDiagnostic } from '../core/diagnostics.js';
import { loadWorkspace } from '../core/files.js';
import { GENERATED_MARKER, generateTypeScript } from '../generator/typescript.js';
import guide from '../../docs/guide.md' with { type: 'text' };

export interface CliIO {
    out: (line: string) => void;
    err: (line: string) => void;
}

const defaultIO: CliIO = {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
};

/** An expected failure: printed as one line on stderr, exiting with `exitCode`. */
class CliError extends Error {
    constructor(message: string, readonly exitCode = 1) {
        super(message);
    }
}

type Format = 'text' | 'json';

const formatOption = () => new Option('--format <format>', 'output format').choices(['text', 'json']).default('text');

/** What `--format json` prints: one JSON document on stdout (see schema/diagnostics.schema.json). */
interface JsonReport {
    diagnostics?: JsonDiagnostic[];
    summary?: { files: number; errors: number; warnings: number };
    /** Output directories written by `generate ts`, relative to the working directory. */
    written?: string[];
    /** Why the command failed, unless only because of the diagnostics of `check`. */
    error?: string;
}

/**
 * Checks the workspace. In text mode the diagnostics and the summary are printed; in JSON mode they are put into
 * `report`, printed by the caller.
 */
async function runCheck(config: ResolvedConfig, io: CliIO, report?: JsonReport): Promise<Analysis> {
    const root = config.root;
    const sources = await loadWorkspace(root, config.sources);
    const analysis = await analyze(sources);
    const errors = analysis.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = analysis.diagnostics.length - errors;
    const noFiles = `No .dt files found under ${root} (sources: ${config.sources.join(', ')}).`;
    if (report) {
        report.diagnostics = analysis.diagnostics.map(jsonDiagnostic);
        report.summary = { files: sources.length, errors, warnings };
        if (sources.length === 0) report.error = noFiles;
        return analysis;
    }
    for (const d of analysis.diagnostics) {
        for (const line of formatDiagnostic(d).split('\n')) (d.severity === 'error' ? io.err : io.out)(line);
    }
    const summary = `${sources.length} file(s) checked: ${errors} error(s), ${warnings} warning(s).`;
    if (sources.length === 0) io.err(noFiles);
    else (errors ? io.err : io.out)(summary);
    return analysis;
}

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
    let exitCode = 0;
    /** Set by commands run with `--format json`; printed once at the end, failures included. */
    let report: JsonReport | undefined;
    const fail = (message: string, code: number): void => {
        if (report) report.error = message;
        else io.err(message);
        exitCode = code;
    };
    const program = new Command()
        .name('dt')
        .description('Domain Modeling DSL: check, generate TypeScript, and view models live.')
        .option('-r, --root <dir>', 'where to look for domaintrail.jsonc / domaintrail.json (and the workspace root without one)', '.')
        .option('-c, --config <file>', 'config file (default: domaintrail.jsonc / domaintrail.json in the root or a parent)')
        .exitOverride()
        .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
        .addHelpText('after', `
Examples:
  dt check                      validate every .dt file below the current directory
  dt -r domain generate ts      check, then write TypeScript (by default into domain/generated/domain)
  dt view                       serve the Live View at http://127.0.0.1:4321 (runs until Ctrl+C)

New to dt, or an AI agent? Read \`dt guide\` first: the DSL, file layout, workflow, config and exit codes.`);

    program
        .command('check')
        .description('Validate syntax, references, types and DDD rules.')
        .addHelpText('after', `
Prints \`file:line:col - error CODE: message\` per problem (errors on stderr, warnings on stdout), followed by an
indented \`hint:\` line when there is a suggested fix, then a summary line. With --format json, prints one JSON document
on stdout instead: {"diagnostics": [...], "summary": {...}}, or {"error": "..."} when the check could not run.
Exits 0 when there are no errors, 1 on errors or when no .dt file is found, 2 on an invalid config.

Examples:
  dt check
  dt check --format json
  dt -r domain check
  dt -c config/domaintrail.jsonc check`)
        .addOption(formatOption())
        .action(async (opts: { format: Format }) => {
            if (opts.format === 'json') report = {};
            const a = await runCheck(await config(), io, report);
            exitCode = a.ok && a.files.length > 0 ? 0 : 1;
        });

    program
        .command('generate')
        .description('Generate code from a valid model.')
        .argument('<target>', 'generation target (ts)')
        .option('-o, --out <dir>', 'output directory relative to the root (default: generate.ts.out, else generated/domain)')
        .addOption(formatOption())
        .addHelpText('after', `
Runs check first and writes nothing if the model has errors (exit 1). Files generated before are replaced, and those
left over from earlier runs (a moved output directory, a removed context) are deleted; other files are never touched.
--out replaces generate.ts.out only: contexts listed in generate.ts.contexts keep their own directories. Like the
directories in the config, it must stay inside the root (exit 2 otherwise) and not lead through a symlink.
With --format json, prints one JSON document like \`check\`, with the directories written ("written") or why
nothing was written ("error").
Type-check your own code against the output with \`tsc --noEmit\`.

Examples:
  dt generate ts
  dt generate ts --out src/domain/generated`)
        .action(async (target: string, opts: { out?: string; format: Format }) => {
            if (opts.format === 'json') report = {};
            if (target !== 'ts') {
                fail(`Unknown target '${target}'. Supported: ts`, 2);
                return;
            }
            const cfg = await config();
            if (opts.out !== undefined && !staysInside(opts.out)) {
                throw new ConfigError(`--out must stay inside ${cfg.root} (the directory of the config file, else the root): '${opts.out}'`);
            }
            const a = await runCheck(cfg, io, report);
            if (a.files.length === 0) {
                exitCode = 1; // reported by runCheck
                return;
            }
            if (!a.ok || !a.model) {
                fail('Generation skipped because the model has errors.', 1);
                return;
            }
            checkTsContexts(cfg, a.model.contexts);
            const defaultOut = path.resolve(cfg.root, opts.out ?? cfg.tsOut);
            const outOf = (ctx: string): string => (ctx in cfg.tsContexts ? path.resolve(cfg.root, cfg.tsContexts[ctx]) : defaultOut);
            // No output directory may leave the project through a symlink, --out included.
            for (const dir of new Set([defaultOut, ...Object.values(cfg.tsContexts).map((d) => path.resolve(cfg.root, d))])) {
                const linked = await symlinkOnPath(cfg.root, dir);
                if (linked) {
                    fail(`Generation skipped: ${linked} is a symlink; an output directory must be a plain directory inside ${cfg.root}.`, 1);
                    return;
                }
            }
            const dirs = Object.fromEntries(a.model.contexts.map((c) => [c, toPosix(path.relative(cfg.root, outOf(c)))]));
            const files = generateTypeScript(a.model, dirs).map((f) => ({ ...f, file: path.resolve(cfg.root, f.path) }));
            const foreign = await foreignFiles(files.map((f) => f.file));
            if (foreign.length) {
                const names = foreign.map((f) => path.relative(process.cwd(), f) || f);
                fail(`Generation skipped: ${names.join(', ')} ${foreign.length > 1 ? 'are' : 'is'} not generated by domaintrail and would be overwritten.`, 1);
                return;
            }
            const outDirs = [...new Set(files.map((f) => path.dirname(f.file)))];
            const previous = await readManifest(cfg.root);
            await removeStale(cfg.root, previous, new Set(files.map((f) => f.file)));
            for (const dir of outDirs) await cleanGenerated(dir);
            for (const f of files) await writeNew(f.file, f.content);
            const recorded = await writeManifest(cfg.root, files.map((f) => f.path));
            if (!recorded) io.err(`Warning: generated files not recorded in ${MANIFEST_FILE}, which is not a plain file in a plain directory; they will not be removed automatically.`);
            const written = outDirs.map((d) => path.relative(process.cwd(), d) || '.');
            if (report) report.written = written;
            else io.out(`TypeScript written to ${written.join(', ')}`);
        });

    program
        .command('view')
        .description('Start the Live View server and watch .dt files (runs until Ctrl+C).')
        .option('-p, --port <port>', 'port to listen on (default: view.port, else 4321)', parsePort)
        .option('--host <host>', 'host to bind (default: view.host, else 127.0.0.1)')
        .addHelpText('after', `
A server that keeps running and never exits by itself: stop it with Ctrl+C. It re-checks on every save and
pushes updates to the browser. Use \`dt check\` for a one-shot result (e.g. from scripts or AI agents).

Examples:
  dt view
  dt view --port 8080
  dt -r examples/shop view`)
        .action(async (opts: { port?: number; host?: string }) => {
            const cfg = await config();
            const { startViewServer } = await import('../server/server.js');
            const port = opts.port ?? cfg.view.port;
            const host = opts.host ?? cfg.view.host;
            const server = await startViewServer({ root: cfg.root, sources: cfg.sources, port, host, log: io.out }).catch((e: unknown) => {
                if (errorCode(e) === 'EADDRINUSE') throw new CliError(`Port ${port} on ${host} is already in use; pick another with --port.`);
                throw e;
            });
            if (cfg.file) io.out(`Config: ${path.relative(process.cwd(), cfg.file) || cfg.file}`);
            io.out(`Live View: ${server.url}`);
            await new Promise<void>(() => {}); // run until interrupted
        });

    program
        .command('guide')
        .description('Print the guide (Markdown): DSL, file layout, workflow, config, output and exit codes.')
        .addHelpText('after', `
The same text as docs/guide.md in the repository. Read it before writing .dt files.

Examples:
  dt guide
  dt guide > domaintrail-guide.md`)
        .action(() => io.out(guide.trimEnd()));

    const config = async () => {
        const start = path.resolve(program.opts().root);
        const info = await stat(start).catch(() => undefined);
        if (!info) throw new CliError(`Root directory not found: ${program.opts().root}`);
        if (!info.isDirectory()) throw new CliError(`Root is not a directory: ${program.opts().root}`);
        return loadConfig({ start, configPath: program.opts().config });
    };

    try {
        await program.parseAsync(argv as string[], { from: 'user' });
    } catch (e) {
        if (e instanceof ConfigError) fail(e.message, 2);
        else if (e instanceof CliError) fail(e.message, e.exitCode);
        // File system and network failures (unreadable directories, permissions…) are reported, not thrown.
        else if (errorCode(e)) fail((e as Error).message, 1);
        else {
            const code = (e as { exitCode?: number }).exitCode;
            if (typeof code === 'number') return code;
            throw e;
        }
    }
    if (report) io.out(JSON.stringify(report, null, 2));
    return exitCode;
}

function parsePort(value: string): number {
    const port = Number(value);
    if (!/^\d+$/.test(value) || port > 65535) throw new InvalidArgumentError('Expected a port number from 0 to 65535.');
    return port;
}

/** The Node.js error code (`ENOENT`, `EACCES`, `EADDRINUSE`…) of a system error. */
function errorCode(e: unknown): string | undefined {
    const code = (e as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : undefined;
}

/**
 * Existing entries at the paths about to be written that the generator may not replace:
 * anything that is not a regular file written by the generator (symlinks included, even dangling ones).
 */
async function foreignFiles(files: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
        if (!(await isGeneratedOrMissing(file))) out.push(file);
    }
    return out;
}

async function isGeneratedOrMissing(file: string): Promise<boolean> {
    const stat = await lstat(file).catch(() => undefined);
    return !stat || (stat.isFile() && (await readFile(file, 'utf8')).startsWith(GENERATED_MARKER));
}

/** The first existing path component between `root` (exclusive) and `target` that is a symlink, if any. */
async function symlinkOnPath(root: string, target: string): Promise<string | undefined> {
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return target;
    let current = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = await lstat(current).catch(() => undefined);
        if (!stat) return undefined;
        if (stat.isSymbolicLink()) return current;
    }
    return undefined;
}

/** Writes via a fresh temp file and rename, so an existing symlink is replaced rather than followed. */
async function writeNew(file: string, content: string): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, file);
}

/**
 * Removes previous output. Only files written by the generator (recognized by their header) are deleted,
 * so pointing the output at a directory with hand-written code never destroys it. `outDir` must already be checked
 * to be inside the root and free of symlinks.
 */
async function cleanGenerated(outDir: string): Promise<void> {
    await mkdir(outDir, { recursive: true });
    for (const entry of await readdir(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const file = path.join(outDir, entry.name);
        if ((await readFile(file, 'utf8')).startsWith(GENERATED_MARKER)) await rm(file);
    }
}

/** Files written by the last `generate ts`, relative to the root, so that a later run can remove those it no longer writes. */
const MANIFEST_FILE = path.join('.domaintrail', 'generated.json');

interface Manifest {
    version: 1;
    /** Root-relative, `/`-separated paths. */
    files: string[];
}

async function readManifest(root: string): Promise<string[]> {
    try {
        const m = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), 'utf8')) as Manifest;
        // the file may have been crafted: entries that would leave the root are dropped
        return m.version === 1 && Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string' && f !== '' && staysInside(f)) : [];
    } catch {
        return [];
    }
}

/** Records the generated files; false when `.domaintrail` is not a plain directory (never written through a symlink). */
async function writeManifest(root: string, files: string[]): Promise<boolean> {
    const target = path.join(root, MANIFEST_FILE);
    const dir = path.dirname(target);
    const existing = await lstat(dir).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) return false;
    await mkdir(dir, { recursive: true });
    const manifest: Manifest = { version: 1, files: [...files].sort() };
    await writeNew(target, `${JSON.stringify(manifest, null, 2)}\n`);
    return true;
}

/**
 * Deletes files of the previous run that this run does not write. Like cleanGenerated, only files with the generator's
 * header are deleted, only inside the root and never through a symlinked directory; a directory left empty is removed
 * too (never the root itself).
 */
async function removeStale(root: string, previous: string[], written: Set<string>): Promise<void> {
    for (const rel of previous) {
        const file = path.resolve(root, rel);
        if (written.has(file) || !file.endsWith('.ts') || !staysInside(rel) || !isInside(root, file)) continue;
        const dir = path.dirname(file);
        if (await symlinkOnPath(root, dir)) continue;
        const stat = await lstat(file).catch(() => undefined);
        if (!stat?.isFile() || !(await isGeneratedOrMissing(file))) continue;
        await rm(file);
        if (dir !== root) await rmdir(dir).catch(() => {}); // fails unless empty
    }
}

const isInside = (root: string, p: string): boolean => {
    const rel = path.relative(root, p);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const toPosix = (p: string): string => p.split(path.sep).join('/');
