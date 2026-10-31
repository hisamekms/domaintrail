import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { analyze, isStormingFile, type Analysis } from '@domaintrail/modeling/core/analyze';
import { ConfigError, checkTsContexts, policyModes, staysInside, type ResolvedConfig } from '@domaintrail/modeling/core/config';
import { formatDiagnostic, jsonDiagnostic, type JsonDiagnostic } from '@domaintrail/modeling/core/diagnostics';
import { formatStorming } from '@domaintrail/modeling/storming/format';
import { formatDomain } from '@domaintrail/modeling/format/format';
import { generateTypeScript } from '@domaintrail/modeling/generator/typescript';
import { guideTopic, parseGuide, quickReference } from './guide.js';
import type { CliDeps } from './ports.js';
import { lookup, showJson, showText } from './show.js';
import guide from '../../../../docs/guide.md' with { type: 'text' };

export interface CliIO {
    out: (line: string) => void;
    err: (line: string) => void;
}

/** Lines to stdout and stderr. */
export const consoleIO: CliIO = {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
};

/** An expected failure: printed as one line on stderr, exiting with `exitCode`. */
class CliError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
    ) {
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
    /** `generate ts`: advice about the project (what text mode prints after `hint: `). */
    hints?: string[];
    /** Why the command failed, unless only because of the diagnostics of `check`. */
    error?: string;
}

/**
 * Checks the workspace. In text mode the diagnostics and the summary are printed; in JSON mode they are put into
 * `report`, printed by the caller.
 */
async function runCheck(config: ResolvedConfig, io: CliIO, deps: CliDeps, report?: JsonReport): Promise<Analysis> {
    const root = config.root;
    const sources = await deps.loadWorkspace(root, config.sources, config.respectGitignore);
    const analysis = await analyze(sources);
    const errors = analysis.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = analysis.diagnostics.length - errors;
    const noFiles = noSourcesMessage(config);
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

/** Runs the CLI and returns the process exit code; `deps` are wired by `src/composition/cli.ts` (`cliDeps`). */
export async function runCli(argv: readonly string[], io: CliIO, deps: CliDeps): Promise<number> {
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
        .addHelpText(
            'after',
            `
Examples:
  dt check                      validate every .dt and .dtes file below the current directory
  dt -r domain generate ts      check, then write TypeScript (by default into domain/generated/domain)
  dt fmt                        rewrite every .dt and .dtes file in the canonical layout (run it after editing)
  dt view                       serve the Live View at http://127.0.0.1:4321 (runs until Ctrl+C)
  dt lsp                        language server over stdio, started by editors and AI agents
  dt show Sales.Order           one element resolved (field sets, labels, commands, used by), instead of reading files

New to dt, or an AI agent? Run \`dt guide\` first: the workflow, the DSL at a glance and the commands, then the list
of topics to read with \`dt guide <topic>\` (e.g. \`dt guide requires\`) when you need one.`,
        );

    program
        .command('check')
        .description('Validate syntax, references, types and DDD rules.')
        .addHelpText(
            'after',
            `
Prints \`file:line:col - error CODE: message\` per problem (errors on stderr, warnings on stdout), followed by an
indented \`hint:\` line when there is a suggested fix, then a summary line. With --format json, prints one JSON document
on stdout instead: {"diagnostics": [...], "summary": {...}}, or {"error": "..."} when the check could not run.
Checks the Event Storming files (.dtes) too, their \`ref\`s against the .dt model; their rules start with S.
Exits 0 when there are no errors, 1 on errors or when no .dt or .dtes file is found, 2 on an invalid config.

Examples:
  dt check
  dt check --format json
  dt -r domain check
  dt -c config/domaintrail.jsonc check`,
        )
        .addOption(formatOption())
        .action(async (opts: { format: Format }) => {
            if (opts.format === 'json') report = {};
            const a = await runCheck(await config(), io, deps, report);
            exitCode = a.ok && a.files.length > 0 ? 0 : 1;
        });

    program
        .command('generate')
        .description('Generate code from a valid model.')
        .argument('<target>', 'generation target (ts)')
        .option('-o, --out <dir>', 'output directory relative to the root (default: generate.ts.out, else generated/domain)')
        .addOption(formatOption())
        .addHelpText(
            'after',
            `
Runs check first and writes nothing if the model has errors (exit 1). Errors in .dtes files are reported but do not
block generation, which reads the .dt files only. Files generated before are replaced, and those
left over from earlier runs (a moved output directory, a removed context) are deleted; other files are never touched.
--out replaces generate.ts.out only: contexts listed in generate.ts.contexts keep their own directories. Like the
directories in the config, it must stay inside the root (exit 2 otherwise) and not lead through a symlink.
With generate.ts.tests in the config, also writes the contract tests (fast-check arbitraries and a suite per
context, by default into <out>/tests); see \`dt guide tests\`.
With --format json, prints one JSON document like \`check\`, with the directories written ("written") or why
nothing was written ("error").
Type-check your own code against the output with \`tsc --noEmit\`. Without a lint rule against casts to domain types
(no-unsafe-type-assertion) in an oxlint or ESLint config from the root up, prints a hint ("hints" in JSON); see
\`dt guide lint\`, or set "lintHint": false.

Examples:
  dt generate ts
  dt generate ts --out src/domain/generated`,
        )
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
            const a = await runCheck(cfg, io, deps, report);
            if (a.files.length === 0) {
                exitCode = 1; // reported by runCheck
                return;
            }
            if (a.documents.length === 0) {
                fail(`Generation skipped: no .dt files found under ${cfg.root} (sources: ${cfg.sources.join(', ')}).`, 1);
                return;
            }
            // a storming is exploration: its errors are reported but never block generation (ADR 0024)
            const modelErrors = a.diagnostics.some((d) => d.severity === 'error' && !isStormingFile(d.file));
            if (modelErrors || !a.model) {
                fail('Generation skipped because the model has errors.', 1);
                return;
            }
            checkTsContexts(cfg, a.model.contexts);
            const defaultOut = path.resolve(cfg.root, opts.out ?? cfg.tsOut);
            const outOf = (ctx: string): string => (ctx in cfg.tsContexts ? path.resolve(cfg.root, cfg.tsContexts[ctx]) : defaultOut);
            // contract tests (ADR 0020) only when configured; by default in `tests` below the output directory
            const testsOut = cfg.tsTests && path.resolve(cfg.root, cfg.tsTests.out ?? path.join(opts.out ?? cfg.tsOut, 'tests'));
            // No output directory may leave the project through a symlink, --out included.
            for (const dir of new Set([defaultOut, ...Object.values(cfg.tsContexts).map((d) => path.resolve(cfg.root, d)), ...(testsOut ? [testsOut] : [])])) {
                const linked = await deps.generatedOutput.symlinkOnPath(cfg.root, dir);
                if (linked) {
                    fail(`Generation skipped: ${linked} is a symlink; an output directory must be a plain directory inside ${cfg.root}.`, 1);
                    return;
                }
            }
            const dirs = Object.fromEntries(a.model.contexts.map((c) => [c, toPosix(path.relative(cfg.root, outOf(c)))]));
            const tests = testsOut
                ? { dir: toPosix(path.relative(cfg.root, testsOut)), ...(cfg.tsTests?.runner && { runner: cfg.tsTests.runner }) }
                : undefined;
            const files = generateTypeScript(a.model, dirs, tests, policyModes(cfg, a.model.contexts)).map((f) => ({
                ...f,
                file: path.resolve(cfg.root, f.path),
            }));
            const foreign = await deps.generatedOutput.foreignFiles(files.map((f) => f.file));
            if (foreign.length) {
                const names = foreign.map((f) => path.relative(process.cwd(), f) || f);
                fail(`Generation skipped: ${names.join(', ')} ${foreign.length > 1 ? 'are' : 'is'} not generated by domaintrail and would be overwritten.`, 1);
                return;
            }
            const outDirs = [...new Set(files.map((f) => path.dirname(f.file)))];
            const { recorded } = await deps.generatedOutput.replace(cfg.root, files);
            if (!recorded)
                io.err(
                    `Warning: generated files not recorded in ${deps.generatedOutput.manifestFile}, which is not a plain file in a plain directory; they will not be removed automatically.`,
                );
            const written = outDirs.map((d) => path.relative(process.cwd(), d) || '.');
            const hint = cfg.lintHint ? await deps.castLintHint(cfg.root) : undefined;
            const hints = hint ? [hint] : [];
            if (report) {
                report.written = written;
                if (hints.length) report.hints = hints;
            } else {
                io.out(`TypeScript written to ${written.join(', ')}`);
                for (const h of hints) io.out(`hint: ${h}`);
            }
        });

    program
        .command('fmt')
        .description('Format .dt and .dtes files in place: one canonical layout, keeping every comment.')
        .argument('[files...]', 'files to format, relative to the current directory (default: the sources of the workspace)')
        .option('--check', 'write nothing; list the files that are not formatted and exit 1 if there are any')
        .addHelpText(
            'after',
            `
Rewrites each file in the layout described in \`dt guide fmt\`: 2-space indentation, one member per line,
a command's clauses on lines of their own unless it is short, and \`[0..1]\` written as \`?\`. Only whitespace and
these spellings change, never the model; comments stay where they are. Run it after editing .dt files.
.dtes files get their own layout: 2-space indentation, one element, clause or timeline step per line, an element
without clauses on one line.
A file with syntax errors is reported like \`dt check\` does and left untouched (exit 1).
Prints the files it changed (with --check, those it would change), then a summary. Exits 0 when every file is
formatted (or, without --check, was formatted), 1 on syntax errors, with --check on a file to change, or when no
.dt or .dtes file is found, 2 on an invalid config.

Examples:
  dt fmt
  dt fmt --check
  dt fmt sales/order.dt
  dt fmt stormings/checkout.dtes
  dt -r domain fmt`,
        )
        .action(async (files: string[], opts: { check?: boolean }) => {
            let entries: { path: string; file: string }[];
            if (files.length) entries = files.map((f) => ({ path: f, file: path.resolve(f) }));
            else {
                const cfg = await config();
                entries = (await deps.findDomainFiles(cfg.root, cfg.sources, cfg.respectGitignore)).map((f) => ({ path: f, file: path.join(cfg.root, f) }));
                if (!entries.length) throw new CliError(noSourcesMessage(cfg));
            }
            const sources = await Promise.all(entries.map(async (e) => ({ path: e.path, text: await readFile(e.file, 'utf8') })));
            const syntax = (await analyze(sources)).diagnostics.filter((d) => d.code === 'SYNTAX');
            for (const d of syntax) for (const line of formatDiagnostic(d).split('\n')) io.err(line);
            const broken = new Set(syntax.map((d) => d.file));
            let changed = 0;
            for (const [i, source] of sources.entries()) {
                if (broken.has(source.path)) continue;
                const formatted = isStormingFile(source.path) ? formatStorming(source.text) : formatDomain(source.text);
                if (formatted === source.text) continue;
                changed++;
                io.out(source.path);
                if (!opts.check) await writeFile(entries[i].file, formatted);
            }
            const skipped = broken.size ? `, ${broken.size} not formatted because of syntax errors` : '';
            const summary = opts.check
                ? `${sources.length} file(s) checked: ${changed} not formatted${skipped}.${changed ? ' Run `dt fmt` to format them.' : ''}`
                : `${sources.length} file(s): ${changed} formatted${skipped}.`;
            (broken.size || (opts.check && changed) ? io.err : io.out)(summary);
            exitCode = broken.size || (opts.check && changed) ? 1 : 0;
        });

    program
        .command('view')
        .description('Start the Live View server and watch .dt and .dtes files (runs until Ctrl+C).')
        .option('-p, --port <port>', 'port to listen on (default: view.port, else 4321)', parsePort)
        .option('--host <host>', 'host to bind (default: view.host, else 127.0.0.1)')
        .option('--base <ref>', 'compare the model with this git revision (e.g. main, HEAD~3) instead of the previous save')
        .addHelpText(
            'after',
            `
A server that keeps running and never exits by itself: stop it with Ctrl+C. It re-checks on every save and
pushes updates to the browser. Use \`dt check\` for a one-shot result (e.g. from scripts or AI agents).

Examples:
  dt view
  dt view --port 8080
  dt view --base main           mark what changed since main (the base can be switched in the page)
  dt -r examples/shop view`,
        )
        .action(async (opts: { port?: number; host?: string; base?: string }) => {
            const cfg = await config();
            const { UnknownRevisionError } = await import('@domaintrail/visualization/application/ports');
            const port = opts.port ?? cfg.view.port;
            const host = opts.host ?? cfg.view.host;
            const server = await deps
                .startViewServer({
                    root: cfg.root,
                    sources: cfg.sources,
                    respectGitignore: cfg.respectGitignore,
                    port,
                    host,
                    base: opts.base,
                    log: io.out,
                })
                .catch((e: unknown) => {
                    if (e instanceof UnknownRevisionError) throw new CliError(`${e.message}: pass a branch, tag or commit to --base.`);
                    if (errorCode(e) === 'EADDRINUSE') throw new CliError(`Port ${port} on ${host} is already in use; pick another with --port.`);
                    throw e;
                });
            if (cfg.file) io.out(`Config: ${path.relative(process.cwd(), cfg.file) || cfg.file}`);
            io.out(`Live View: ${server.url}`);
            await new Promise<void>(() => {}); // run until interrupted
        });

    program
        .command('lsp')
        .description('Start the language server over stdio, for editors and AI agents (runs until the client exits).')
        .option('--stdio', 'talk over stdin/stdout (the default and only transport; accepted for clients that pass it)')
        .addHelpText(
            'after',
            `
Speaks the Language Server Protocol on stdin/stdout for .dt and .dtes files: the diagnostics of \`dt check\` (same rules, codes
and messages, over the whole workspace and the unsaved text of open files), go to definition, find references, hover,
outline, rename of declarations, completion and formatting (as \`dt fmt\`). The workspace is the config found from
--root or --config, else from the client's workspace folder, else from the current directory; when none is found
there, the nearest config of the first .dt file opened below it. Started by an LSP client, not by hand.

Examples:
  dt lsp
  dt -r domain lsp`,
        )
        .action(async () => {
            const root = program.getOptionValueSource('root') === 'default' ? undefined : path.resolve(program.opts().root);
            if (root !== undefined || program.opts().config) await config(); // fail early on a bad --root or --config
            await deps.startLanguageServer({ root, configPath: program.opts().config });
            await new Promise<void>(() => {}); // the server exits the process when the client says so
        });

    program
        .command('show')
        .description('Print the resolved model of one element, state, command or context (all contexts without a name).')
        .argument('[name]', 'Sales.Order, Order, Sales, Sales.Order.confirm (a command), Sales.Order.Confirmed (a state)')
        .addOption(formatOption())
        .addHelpText(
            'after',
            `
Prints one element close to the DSL, resolved: the fields of field sets inline, every label with where it comes from,
states, commands with their requirements, changes, events per outcome and full error union, \`file:line\` locations
and who uses it. A name may leave out leading parts (\`Order\`, \`Order.confirm\`) when it names one thing only;
otherwise the candidates are listed. With --format json, prints one JSON document ({"show": "element", ...}, or
{"error": "...", "candidates": [...]}). Works on models with semantic errors as far as they resolve (a note on stderr
gives their count; see \`dt check\`). Exits 0 when the name was found, whatever the diagnostics, 1 when it was not found
or is ambiguous, 2 on an invalid config.

Examples:
  dt show
  dt show Sales.Order
  dt show Order.confirm --format json
  dt -r domain show Sales`,
        )
        .action(async (name: string | undefined, opts: { format: Format }) => {
            const json = opts.format === 'json';
            const cfg = await config();
            // .dt only: stormings are not shown in v0.1 (ADR 0024)
            const sources = (await deps.loadWorkspace(cfg.root, cfg.sources, cfg.respectGitignore)).filter((s) => !isStormingFile(s.path));
            if (sources.length === 0) throw new CliError(`No .dt files found under ${cfg.root} (sources: ${cfg.sources.join(', ')}).`);
            const a = await analyze(sources);
            if (!a.model) throw new CliError('The model has syntax errors; run `dt check` and fix them first.');
            const errors = a.diagnostics.filter((d) => d.severity === 'error').length;
            const found = name === undefined ? undefined : lookup(a.model, name);
            if (found && !('found' in found)) {
                const candidates = 'ambiguous' in found ? found.ambiguous : found.suggestions;
                const message =
                    'ambiguous' in found
                        ? `'${name}' is ambiguous: ${candidates.join(', ')}. Use the full name.`
                        : `Unknown name '${name}'${found.hint ? `; ${found.hint}` : '.'}`;
                if (json) io.out(JSON.stringify({ error: message, ...(candidates.length && { candidates }) }, null, 2));
                else io.err(message);
                exitCode = 1;
                return;
            }
            const target = found?.found;
            if (json) {
                io.out(JSON.stringify({ ...showJson(a.model, target), ...(errors && { modelErrors: errors }) }, null, 2));
                return;
            }
            for (const line of showText(a.model, target)) io.out(line);
            if (errors) io.err(`note: the model has ${errors} error(s) (see \`dt check\`); shown as far as it resolves.`);
        });

    program
        .command('guide')
        .description('Print the guide (Markdown): a quick reference and the topics, one topic, or all of it.')
        .argument('[topic]', 'a topic (workflow, dsl, requires, decide, …) or a rule code (M010)')
        .option('--all', 'print the whole guide')
        .addHelpText(
            'after',
            `
Without a topic, prints the quick reference (the workflow, the DSL at a glance, the commands) and the list of
topics. With a topic, prints that section of the guide (a ## section with its ### sections); with a rule code, the
rule and the topics that explain it. An unknown topic is an error with suggestions (exit 1). With --all, prints the
whole guide, the same text as docs/guide.md in the repository.

Examples:
  dt guide
  dt guide requires
  dt guide M010
  dt guide --all > domaintrail-guide.md`,
        )
        .action((topic: string | undefined, opts: { all?: boolean }) => {
            if (opts.all) {
                if (topic) throw new CliError('Give a topic or --all, not both.');
                io.out(guide.trimEnd());
                return;
            }
            const parsed = parseGuide(guide);
            if (!topic) return io.out(quickReference(parsed));
            const found = guideTopic(parsed, topic);
            if ('error' in found) throw new CliError(found.error);
            io.out(found.text);
        });

    const config = async () => {
        const start = path.resolve(program.opts().root);
        const info = await stat(start).catch(() => undefined);
        if (!info) throw new CliError(`Root directory not found: ${program.opts().root}`);
        if (!info.isDirectory()) throw new CliError(`Root is not a directory: ${program.opts().root}`);
        return deps.loadConfig({ start, configPath: program.opts().config });
    };

    try {
        await program.parseAsync([...argv], { from: 'user' });
    } catch (e) {
        if (e instanceof ConfigError) fail(e.message, 2);
        else if (e instanceof CliError) fail(e.message, e.exitCode);
        // File system and network failures (unreadable directories, permissions…) are reported, not thrown.
        else if (errorCode(e)) fail(e instanceof Error ? e.message : String(e), 1);
        else {
            const code = typeof e === 'object' && e !== null && 'exitCode' in e ? e.exitCode : undefined;
            if (typeof code === 'number') return code;
            throw e;
        }
    }
    if (report) io.out(JSON.stringify(report, null, 2));
    return exitCode;
}

function noSourcesMessage(cfg: ResolvedConfig): string {
    return `No .dt or .dtes files found under ${cfg.root} (sources: ${cfg.sources.join(', ')}).`;
}

function parsePort(value: string): number {
    const port = Number(value);
    if (!/^\d+$/.test(value) || port > 65535) throw new InvalidArgumentError('Expected a port number from 0 to 65535.');
    return port;
}

/** The Node.js error code (`ENOENT`, `EACCES`, `EADDRINUSE`…) of a system error. */
function errorCode(e: unknown): string | undefined {
    const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
    return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : undefined;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');
