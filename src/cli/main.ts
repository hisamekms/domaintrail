import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import { analyze, type Analysis } from '../core/analyze.js';
import { ConfigError, loadConfig, type ResolvedConfig } from '../core/config.js';
import { formatDiagnostic } from '../core/diagnostics.js';
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

async function runCheck(config: ResolvedConfig, io: CliIO): Promise<Analysis> {
    const root = config.root;
    const sources = await loadWorkspace(root, config.sources);
    const analysis = await analyze(sources);
    for (const d of analysis.diagnostics) (d.severity === 'error' ? io.err : io.out)(formatDiagnostic(d));
    const errors = analysis.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = analysis.diagnostics.length - errors;
    const summary = `${sources.length} file(s) checked: ${errors} error(s), ${warnings} warning(s).`;
    if (sources.length === 0) io.err(`No .dt files found under ${root} (sources: ${config.sources.join(', ')}).`);
    else (errors ? io.err : io.out)(summary);
    return analysis;
}

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
    let exitCode = 0;
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
Prints \`file:line:col - error CODE: message\` per problem (errors on stderr, warnings on stdout), then a summary line.
Exits 0 when there are no errors, 1 on errors or when no .dt file is found, 2 on an invalid config.

Examples:
  dt check
  dt -r domain check
  dt -c config/domaintrail.jsonc check`)
        .action(async () => {
            const a = await runCheck(await config(), io);
            exitCode = a.ok && a.files.length > 0 ? 0 : 1;
        });

    program
        .command('generate')
        .description('Generate code from a valid model.')
        .argument('<target>', 'generation target (ts)')
        .option('-o, --out <dir>', 'output directory relative to the root (default: generate.ts.out, else generated/domain)')
        .addHelpText('after', `
Runs check first and writes nothing if the model has errors (exit 1). Files generated before are replaced;
other files in the output directory are never touched. Type-check your own code against the output with \`tsc --noEmit\`.

Examples:
  dt generate ts
  dt generate ts --out src/domain/generated`)
        .action(async (target: string, opts: { out?: string }) => {
            if (target !== 'ts') {
                io.err(`Unknown target '${target}'. Supported: ts`);
                exitCode = 2;
                return;
            }
            const cfg = await config();
            const a = await runCheck(cfg, io);
            if (!a.ok || !a.model) {
                io.err('Generation skipped because the model has errors.');
                exitCode = 1;
                return;
            }
            const outDir = path.resolve(cfg.root, opts.out ?? cfg.tsOut);
            // An output directory from the config must not leave the project through a symlink
            // (an explicit --out is the user's own choice).
            const linked = opts.out === undefined ? await symlinkOnPath(cfg.root, outDir) : undefined;
            if (linked) {
                io.err(`Generation skipped: ${linked} is a symlink; the output directory from the config must be a plain directory inside ${cfg.root}.`);
                exitCode = 1;
                return;
            }
            const files = generateTypeScript(a.model);
            const foreign = await foreignFiles(outDir, files.map((f) => f.path));
            if (foreign.length) {
                io.err(`Generation skipped: ${foreign.join(', ')} in ${outDir} ${foreign.length > 1 ? 'are' : 'is'} not generated by domaintrail and would be overwritten.`);
                exitCode = 1;
                return;
            }
            await cleanGenerated(outDir);
            for (const f of files) await writeNew(path.join(outDir, f.path), f.content);
            io.out(`TypeScript written to ${path.relative(process.cwd(), outDir) || '.'}`);
        });

    program
        .command('view')
        .description('Start the Live View server and watch .dt files (runs until Ctrl+C).')
        .option('-p, --port <port>', 'port to listen on (default: view.port, else 4321)')
        .option('--host <host>', 'host to bind (default: view.host, else 127.0.0.1)')
        .addHelpText('after', `
A server that keeps running and never exits by itself: stop it with Ctrl+C. It re-checks on every save and
pushes updates to the browser. Use \`dt check\` for a one-shot result (e.g. from scripts or AI agents).

Examples:
  dt view
  dt view --port 8080
  dt -r examples/shop view`)
        .action(async (opts: { port?: string; host?: string }) => {
            const cfg = await config();
            const { startViewServer } = await import('../server/server.js');
            const server = await startViewServer({
                root: cfg.root,
                sources: cfg.sources,
                port: opts.port !== undefined ? Number(opts.port) : cfg.view.port,
                host: opts.host ?? cfg.view.host,
                log: io.out,
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

    const config = () => loadConfig({ start: path.resolve(program.opts().root), configPath: program.opts().config });

    try {
        await program.parseAsync(argv as string[], { from: 'user' });
    } catch (e) {
        if (e instanceof ConfigError) {
            io.err(e.message);
            return 2;
        }
        const code = (e as { exitCode?: number }).exitCode;
        if (typeof code === 'number') return code;
        throw e;
    }
    return exitCode;
}

/**
 * Existing entries with the names about to be written that the generator may not replace:
 * anything that is not a regular file written by the generator (symlinks included, even dangling ones).
 */
async function foreignFiles(outDir: string, names: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const name of names) {
        const file = path.join(outDir, name);
        const stat = await lstat(file).catch(() => undefined);
        if (!stat) continue;
        if (!stat.isFile() || !(await readFile(file, 'utf8')).startsWith(GENERATED_MARKER)) out.push(name);
    }
    return out;
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
 * so pointing the output at a directory with hand-written code never destroys it.
 */
async function cleanGenerated(outDir: string): Promise<void> {
    await mkdir(outDir, { recursive: true });
    for (const entry of await readdir(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const file = path.join(outDir, entry.name);
        if ((await readFile(file, 'utf8')).startsWith(GENERATED_MARKER)) await rm(file);
    }
}
