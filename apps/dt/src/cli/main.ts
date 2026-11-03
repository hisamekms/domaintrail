import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { contextNames, formatDomain } from '@domaintrail/modeling';
import { formatStorming, isStormingFile } from '@domaintrail/storming';
import { generateTypeScript, policyModes, staysInside, testsWarnings } from '@domaintrail/generation';
import { type Analysis, analyze } from '@domaintrail/analysis';
import { formatDiagnostic, jsonDiagnostic, type JsonDiagnostic } from '@domaintrail/kernel';
import { checkTestsTypes, checkTsContexts, ConfigError, type ResolvedConfig } from '../config/config.js';
import { guideTopic, parseGuide, practiceOf, quickReference } from './guide.js';
import {
    AGENT_ROLES,
    type AgentOptions,
    type AgentRole,
    type CliDeps,
    SessionError,
    type SessionSettings,
    type SourcesExportOptions,
    type StartedAgent,
    type StartedSession,
    type StartedTunnel,
    TunnelError,
} from './ports.js';
import { lookup, showJson, showText } from './show.js';
import { approveSettings, NotApproved, type StartFlags } from './trust.js';
import guide from '../../../../docs/guide.md' with { type: 'text' };

export interface CliIO {
    out: (line: string) => void;
    err: (line: string) => void;
    /** Bytes to stdout (`dt export sources -o -`); absent where there is no binary output. */
    bytes?: (data: Uint8Array) => Promise<void>;
}

/** Lines to stdout and stderr. */
export const consoleIO: CliIO = {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    bytes: (data) => new Promise<void>((resolve, reject) => void process.stdout.write(data, (e) => (e ? reject(e) : resolve()))),
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

/** Runs the CLI and returns the process exit code; `deps` are wired by `main.ts` (`cliDeps`). */
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
        .option(
            '-c, --config <file>',
            'config file (default: domaintrail.jsonc / domaintrail.json in the root or a parent; <name>.local.<ext> beside it is merged in)',
        )
        .exitOverride()
        .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
        .addHelpText(
            'after',
            `
Examples:
  dt check                      validate every .dt and .dtes file below the current directory
  dt -r domain generate ts      check, then write TypeScript (by default into domain/generated/domain)
  dt fmt                        rewrite every .dt and .dtes file in the canonical layout (run it after editing)
  dt open                       the Live View with the chat and the AI at http://127.0.0.1:4321 (runs until Ctrl+C)
  dt lsp                        language server over stdio, started by editors and AI agents
  dt show Sales.Order           one element resolved (field sets, labels, commands, used by), instead of reading files
  dt export sources             the .dt and .dtes files and the config as <workspace>-sources.zip, to share without git

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
A context with generate.ts.contexts.<Context>.module is imported from that module by the code of other directories,
and its contract tests are written into <its out>/tests.
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
            checkTsContexts(cfg, contextNames(a.model));
            checkTestsTypes(
                cfg,
                a.model.elements.map((e) => e.id),
            );
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
            const dirs = Object.fromEntries(contextNames(a.model).map((c) => [c, toPosix(path.relative(cfg.root, outOf(c)))]));
            const tests = testsOut
                ? {
                      dir: toPosix(path.relative(cfg.root, testsOut)),
                      ...(cfg.tsTests?.runner && { runner: cfg.tsTests.runner }),
                      ...(cfg.tsTests?.maxRecursionDepth !== undefined && { maxRecursionDepth: cfg.tsTests.maxRecursionDepth }),
                      ...(cfg.tsTests?.types && { types: cfg.tsTests.types }),
                  }
                : undefined;
            const policies = policyModes(cfg, contextNames(a.model));
            if (tests) for (const w of testsWarnings(a.model, tests.types)) io.err(`Warning: ${w}`);
            const files = generateTypeScript(a.model, dirs, tests, policies, cfg.tsModules).map((f) => ({
                ...f,
                file: path.resolve(cfg.root, f.path),
            }));
            // Every directory written to, those the generator chose included (the contract tests of a context with a
            // `module`, in <its out>/tests), checked the same way before anything is written.
            for (const dir of new Set(files.map((f) => path.dirname(f.file)))) {
                const linked = await deps.generatedOutput.symlinkOnPath(cfg.root, dir);
                if (linked) {
                    fail(`Generation skipped: ${linked} is a symlink; an output directory must be a plain directory inside ${cfg.root}.`, 1);
                    return;
                }
            }
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
        .command('export')
        .description('Export the model: its sources as one ZIP archive.')
        .command('sources')
        .description('Write the .dt and .dtes files and the config file as one ZIP archive, folders kept.')
        .option('-o, --out <file>', 'the archive to write, `-` for stdout (default: <workspace>-sources.zip in the current directory)')
        .addHelpText(
            'after',
            `
Archives the files \`dt check\` analyzes (only .dt and .dtes files) and the config file (domaintrail.jsonc / .json),
below one folder named after the workspace (the root's directory): \`shop/sales/order.dt\`. Never the local override
(domaintrail.local.jsonc), .domaintrail or .git, generated output, symlinks, or, in a git repository, files git ignores.
Unzip it anywhere and run \`dt check\` in the folder: no git needed. An existing file is replaced.
Exits 0 when written, 1 when the workspace has no .dt or .dtes file, 2 on an invalid config.

Examples:
  dt export sources                     writes shop-sources.zip
  dt export sources -o /tmp/model.zip
  dt export sources -o - > model.zip
  dt -r domain export sources`,
        )
        .action(async (opts: { out?: string }) => {
            const cfg = await config();
            const archive = await deps.exportSources(workspaceOf(cfg));
            if (!archive.sources) throw new CliError(noSourcesMessage(cfg));
            const summary = (where: string): string => `${archive.files.length} file(s) written to ${where}`;
            if (opts.out === '-') {
                if (!io.bytes) throw new CliError('Cannot write the archive to stdout here.');
                await io.bytes(archive.zip);
                io.err(summary('stdout'));
                return;
            }
            const file = path.resolve(opts.out ?? `${archive.name}-sources.zip`);
            await writeFile(file, archive.zip);
            const rel = path.relative(process.cwd(), file);
            io.out(summary(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file));
        });

    const serveOptions = (command: Command, section: 'open' | 'collab', hostHelp: string): Command =>
        command
            .option('-p, --port <port>', `port to listen on (default: ${section}.port, else 4321)`, parsePort)
            .option('--host <host>', hostHelp)
            .option('--base <ref>', 'compare the model with this git revision (e.g. main, HEAD~3) instead of the previous save')
            .addOption(new Option('--agent <agent>', 'the agent to start in this process (an error if it cannot start)').choices(['claude']))
            .option('--no-agent', 'do not start the agent in this process (start one later with `dt agent`)')
            .option('--yes', 'approve changed security-relevant settings without asking (for scripts; they are printed)');

    const open = serveOptions(
        program
            .command('open')
            .description('Open the Live View with the chat for you alone, the AI included (runs until Ctrl+C).')
            .addHelpText(
                'after',
                `
Serves the Live View and a chat for one person on loopback. It prints a one-time link: opened within 60 minutes, it
signs that browser in as you, the facilitator (a cookie; no join form); nothing else is let in (\`dt open link\` prints
another link while it runs). Every message you send goes to the AI, which answers questions and applies change requests. It re-checks on
every save and pushes updates to the browser. The chat, the runs and the revisions are kept in .domaintrail/session/
across restarts. The agent (Claude Code) starts in this process when \`claude\` is usable; otherwise the server starts
without it and says why (\`dt agent\` connects one later). Refused while the workspace has an open collab session
(\`dt collab\` resumes it). With --host on a non-loopback address, the Live View is served read-only: no chat, no agent.
Use \`dt check\` for a one-shot result (e.g. from scripts or AI agents).

Examples:
  dt open
  dt open --port 8080
  dt open --base main           mark what changed since main (the base can be switched in the page)
  dt open --no-agent            the chat without the AI in this process (dt agent elsewhere)
  dt open link                  another sign-in link, for another browser or after the first expired
  dt -r examples/shop open`,
            ),
        'open',
        'host to bind (default: open.host, else 127.0.0.1; a non-loopback address serves the Live View read-only)',
    ).action(async (opts: ServeOptions) => {
        const cfg = await config();
        await approve(cfg, opts.yes);
        const { UnknownRevisionError } = await import('@domaintrail/visualization');
        const port = opts.port ?? cfg.open.port;
        const host = opts.host ?? cfg.open.host;
        const base = (e: unknown): never => {
            if (e instanceof UnknownRevisionError) throw new CliError(`${e.message}: pass a branch, tag or commit to --base.`);
            if (errorCode(e) === 'EADDRINUSE') throw new CliError(`Port ${port} on ${host} is already in use; pick another with --port.`);
            throw e;
        };
        if (!isLoopback(host)) {
            // what remains of `dt view`: the Live View alone, read-only, for others to look at
            if (opts.agent === 'claude') throw new CliError(`No agent with a read-only Live View: ${host} is not a loopback address.`);
            const server = await deps.startViewServer({ ...workspaceOf(cfg), port, host, base: opts.base, log: io.out }).catch(base);
            await printConfig(cfg, []);
            io.out(`Live View (read-only: ${host} is not a loopback address; the chat and the agent are on loopback only): ${server.url}`);
            await new Promise<void>(() => {}); // run until interrupted
            return;
        }
        const server = await deps
            .startSessionServer({
                ...workspaceOf(cfg),
                base: opts.base,
                mode: 'Solo',
                session: openSettings(cfg, port, host),
                log: io.out,
            })
            .catch((e: unknown) => {
                if (e instanceof SessionError) throw new CliError(e.message);
                return base(e);
            });
        await printConfig(cfg);
        // the printed link is the only step: opened once, it signs this browser in (a cookie) as the one person
        io.out(`Live View: ${server.facilitatorLink ?? server.url}`);
        io.out(`  (a link for you only: opened once within 60 minutes, it signs that browser in; then ${server.url}; \`dt open link\` prints another)`);
        io.out(`Session: ${server.session} (${server.opened}, solo)`);
        await serveWithAgent(cfg, opts, server);
    });

    const collab = serveOptions(
        program
            .command('collab')
            .option('--tunnel', 'serve the session on the internet through a Cloudflare quick tunnel (cloudflared, no account): identity link')
            .description('Start the collaboration session: the Live View, the chat and the AI for several people (runs until Ctrl+C or the session closes).')
            .addHelpText(
                'after',
                `
Serves the Live View and the workspace's collaboration session: participants sign in (identity mode
collab.identity: dev, a name picked in the browser on loopback; access, Cloudflare Access), send messages about
elements of the model, and address the AI with @AI; the facilitator decides what changes. One session per workspace:
an open session is resumed, and a \`dt open\` session is continued with you as its facilitator. Prints a one-time
facilitator link: open it in your browser to become the facilitator (\`dt collab link\` prints another). With
--tunnel, \`cloudflared\` gives the session a temporary public https://….trycloudflare.com address and the identity
mode is link: people join through the invite link printed (and the page's 招待), and you let each one in from the
page (docs/session-link.md); cloudflared stops with the session. The agent
(Claude Code) starts in this process when \`claude\` is usable; otherwise the server starts without it and says why.
The agent API listens on 127.0.0.1 only; its credential is in memory, never on disk (\`dt collab agent-link\` pairs
another agent).

Examples:
  dt collab
  dt collab --port 8080
  dt collab --no-agent          the agent on another machine or terminal (dt agent)
  dt collab --tunnel            on the internet: an invite link and your approval of each person
  dt collab link                another facilitator link
  dt -r examples/shop collab`,
            ),
        'collab',
        'host to bind (default: collab.host, else 127.0.0.1; the dev identity mode allows loopback only)',
    ).action(async (opts: ServeOptions & { tunnel?: boolean }) => {
        const cfg = await config();
        if (opts.tunnel && cfg.collab.identity === 'access')
            throw new CliError(
                '--tunnel starts a quick tunnel for the link identity mode; with identity "access", run your own named tunnel (docs/session-access.md).',
            );
        await approve(cfg, opts.yes, { tunnel: opts.tunnel ?? false });
        const { UnknownRevisionError } = await import('@domaintrail/visualization');
        let settings = sessionSettings(cfg, cfg.collab, opts);
        let tunnel: StartedTunnel | undefined;
        if (opts.tunnel) {
            if (settings.port === 0) throw new CliError('--tunnel needs a fixed port: pass --port (or set collab.port).');
            if (!isLoopback(settings.host))
                throw new CliError(`--tunnel serves loopback only (cloudflared connects there); ${settings.host} is not a loopback address.`);
            tunnel = await deps.startTunnel({ port: settings.port, log: io.out }).catch((e: unknown) => {
                if (e instanceof TunnelError) throw new CliError(e.message);
                throw e;
            });
            settings = { ...settings, identity: 'link', link: { publicUrl: tunnel.url } };
            io.out(`Tunnel: ${tunnel.url} (a Cloudflare quick tunnel: public, temporary, gone when the session ends)`);
        }
        const server = await deps
            .startSessionServer({
                ...workspaceOf(cfg),
                base: opts.base,
                mode: 'Collab',
                session: settings,
                ...(tunnel && { quickTunnel: true }),
                log: io.out,
            })
            .catch(async (e: unknown) => {
                await tunnel?.stop();
                if (e instanceof SessionError) throw new CliError(e.message);
                if (e instanceof UnknownRevisionError) throw new CliError(`${e.message}: pass a branch, tag or commit to --base.`);
                if (errorCode(e) === 'EADDRINUSE')
                    throw new CliError(`Port ${settings.port} on ${settings.host} (or the agent port) is already in use; pick another with --port.`);
                throw e;
            });
        // cloudflared ending by itself ends nothing else: the session goes on, on this machine
        void tunnel?.exited.then(() => io.out('Tunnel: cloudflared stopped.'));
        await printConfig(cfg);
        const opened = server.opened === 'collaborated' ? 'continued from dt open' : server.opened;
        io.out(`Session: ${server.session} (${opened}, identity ${settings.identity})`);
        io.out(`Live View: ${server.publicUrl ? `${server.publicUrl}/ (on this machine: ${server.url})` : server.url}`);
        if (server.facilitatorLink) io.out(`Facilitator link (single use, expires in 10 minutes): ${server.facilitatorLink}`);
        if (server.issueInvite) {
            // `link`: the invite to share; each person who opens it asks to join, and you let them in from the page
            const invite = await server.issueInvite();
            io.out(`Invite link (anyone with it can ask to join; expires in 60 minutes; the page's 招待 makes another): ${invite.link}`);
        }
        io.out(`Agent API: ${server.agentUrl} (another agent pairs with a code: dt collab agent-link)`);
        try {
            await serveWithAgent(cfg, opts, server);
        } finally {
            await tunnel?.stop();
        }
    });
    collab
        .command('link')
        .description('Print another one-time facilitator link for the collaboration session running on the workspace.')
        .addHelpText(
            'after',
            `
The link makes whoever opens it while signed in the facilitator (the previous facilitator loses the role). It works
once, for 10 minutes.

Examples:
  dt collab link
  dt -r examples/shop collab link`,
        )
        .action(async () => {
            const cfg = await config();
            const { link } = await deps.issueFacilitatorLink(cfg.root).catch((e: unknown) => {
                if (e instanceof SessionError) throw new CliError(e.message);
                throw e;
            });
            io.out(`Facilitator link (single use, expires in 10 minutes): ${link}`);
        });

    collab
        .command('invite')
        .description('Print a new invite link for the link-mode collaboration session running on the workspace (the previous one stops working).')
        .option('--stop', 'stop the invite link instead: nobody can ask to join with it any more')
        .addHelpText(
            'after',
            `
In the link identity mode (\`dt collab --tunnel\`, or collab.identity "link"), people join through an invite link:
whoever opens it gives a name and waits until the facilitator lets them in (or not) from the page. The link works for
60 minutes, any number of times; a new one stops the previous one, and the requests made through it expire.

Examples:
  dt collab invite
  dt collab invite --stop`,
        )
        .action(async (opts: { stop?: boolean }) => {
            const cfg = await config();
            const invite = await deps.issueInvite(cfg.root, opts.stop ?? false).catch((e: unknown) => {
                if (e instanceof SessionError) throw new CliError(e.message);
                throw e;
            });
            if ('stopped' in invite) io.out(invite.stopped ? 'Invite link stopped.' : 'No invite link was live.');
            else io.out(`Invite link (anyone with it can ask to join; expires in 60 minutes): ${invite.link}`);
        });

    open.command('link')
        .description('Print another one-time sign-in link for the `dt open` server running on the workspace.')
        .addHelpText(
            'after',
            `
The link signs the browser that opens it in as you, as the link \`dt open\` printed does: it works once, for 60
minutes, and every link dies with the server. For another browser, or when the first link expired, without restarting
\`dt open\`. A \`dt collab\` server is refused: \`dt collab link\` prints its facilitator link.

Examples:
  dt open link
  dt -r examples/shop open link`,
        )
        .action(async () => {
            const cfg = await config();
            const { link } = await deps.issueOpenLink(cfg.root).catch((e: unknown) => {
                if (e instanceof SessionError) throw new CliError(e.message);
                throw e;
            });
            io.out(`Sign-in link (single use, expires in 60 minutes): ${link}`);
        });

    // a one-time code for a standalone `dt agent` (the credential itself is never written to disk)
    for (const [parent, name] of [
        [open, 'open'],
        [collab, 'collab'],
    ] as const) {
        parent
            .command('agent-link')
            .description(
                `Print a one-time code that pairs a standalone \`dt agent\` with the ${name === 'open' ? '`dt open`' : 'collaboration'} server running on the workspace.`,
            )
            .addHelpText(
                'after',
                `
\`dt agent --code <code>\` exchanges the code for the agent API's credential, which it keeps in memory: the credential
is never written to disk. The code works once, for 10 minutes, and dies with the server.

Examples:
  dt ${name} agent-link
  dt agent --code <code>`,
            )
            .action(async () => {
                const cfg = await config();
                const { code, agentUrl } = await deps.issueAgentLink(cfg.root).catch((e: unknown) => {
                    if (e instanceof SessionError) throw new CliError(e.message);
                    throw e;
                });
                io.out(`Agent code (single use, expires in 10 minutes): ${code}`);
                io.out(`Agent API: ${agentUrl}`);
                io.out(`Run: dt agent --code ${code}`);
            });
    }

    program
        .command('agent')
        .description('Run the AI on the session running on the workspace: its answers and its runs (runs until Ctrl+C or the session closes).')
        .addOption(new Option('--agent <agent>', 'the agent').choices(['claude']).default('claude'))
        .addOption(new Option('--role <role>', 'take on one role only: answer (read-only answers) or run (the runs); default: both').choices([...AGENT_ROLES]))
        .option('--once', 'handle one run (waiting for one if none is queued), then exit')
        .requiredOption('--code <code>', 'the one-time pairing code of `dt collab agent-link` (or `dt open agent-link`)')
        .option('--url <url>', "the agent API's address (default: the running server's, from .domaintrail/session/server.json)")
        .option('--yes', 'approve changed security-relevant settings without asking (for scripts; they are printed)')
        .addHelpText(
            'after',
            `
Connects to the session server running on the workspace (\`dt open\` or \`dt collab\`, e.g. started with --no-agent)
through its agent API: the code printed by \`dt collab agent-link\` is exchanged once for the agent API's credential,
kept in memory (never on disk). The runner takes the runs one at a
time: Claude Code (\`claude\` on the PATH, with the tools of agent.run.allowedTools only) edits the .dt and .dtes files
(its \`dt\` is agent.run.dt, else this very CLI), then \`dt fmt\` and \`dt check\` run and the server records the result
as a revision. A run that changes any other file fails. The answerer answers the questions addressed to the AI with
read-only tools. Ctrl+C stops the agent and fails its run as interrupted. Another \`dt agent\` beside the one in
process is allowed.

Examples:
  dt collab agent-link          prints the code
  dt agent --code <code>
  dt agent --code <code> --role run   the runs only (the answers from another dt agent --role answer)
  dt agent --code <code> --once
  dt -r examples/shop agent --code <code>`,
        )
        .action(async (opts: { agent: 'claude'; role?: AgentRole; once?: boolean; code: string; url?: string; yes?: boolean }) => {
            const cfg = await config();
            await approve(cfg, opts.yes);
            await printConfig(cfg, opts.role ? [opts.role] : AGENT_ROLES);
            const connect = { code: opts.code, ...(opts.url !== undefined && { url: opts.url }) };
            const agent = await deps
                .startAgent({ ...agentOptions(cfg, opts.agent), connect, roles: opts.role ? [opts.role] : AGENT_ROLES, once: opts.once ?? false, log: io.out })
                .catch((e: unknown) => {
                    if (e instanceof SessionError) throw new CliError(e.message);
                    throw e;
                });
            io.out(`Agent on session ${agent.session} with ${opts.agent} (${rolesText(agent.roles)})${opts.once ? ' (one run)' : ''}; waiting.`);
            const end = await agent.done;
            if (end === 'lost') throw new CliError('The session server is gone or refused the agent credential.');
            io.out(end === 'closed' ? 'Session closed.' : end === 'once' ? 'Done.' : 'Stopped.');
        });

    // the commands removed by ADR 0030: an error naming the replacement, no alias
    removed(program, 'view', "'dt view' was removed; use 'dt open' (or 'dt open --host <address>' for a read-only Live View)");
    const session = removed(program, 'session', "'dt session' was removed; use 'dt collab' (start), 'dt collab link' or 'dt agent'");
    removed(session, 'start', "'dt session start' was removed; use 'dt collab'");
    removed(session, 'link', "'dt session link' was removed; use 'dt collab link'");
    removed(session, 'subscribe', "'dt session subscribe' was removed; use 'dt agent'");

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

    /** The agent's settings for `dt agent` or the agent in process. */
    const agentOptions = (cfg: ResolvedConfig, agent: 'claude'): Omit<AgentOptions, 'roles' | 'once' | 'log' | 'connect'> => {
        const configPath = program.opts<{ config?: string }>().config;
        return {
            root: cfg.root,
            sources: cfg.sources,
            respectGitignore: cfg.respectGitignore,
            configPath: configPath === undefined ? undefined : path.resolve(configPath),
            agent,
            ...(cfg.agent.run.dt && { dt: cfg.agent.run.dt }),
            run: cfg.agent.run,
            answer: cfg.agent.answer,
            triage: cfg.agent.triage,
            read: cfg.agent.read,
            practice: practiceOf(parseGuide(guide)),
        };
    };

    /**
     * Starts the agent in this process (both roles, over loopback HTTP as `dt agent` would) unless `--no-agent`; when
     * Claude Code is not usable, says why in one line and goes on without it (an error with `--agent claude`). Then
     * serves until the session closes.
     */
    const serveWithAgent = async (cfg: ResolvedConfig, opts: ServeOptions, server: StartedSession): Promise<void> => {
        let agent: StartedAgent | undefined;
        try {
            if (opts.agent === false) io.out('AI: not started (--no-agent); start it with `dt agent`');
            else {
                const usable = await deps.checkAgent('claude');
                if (!usable.ok) {
                    if (opts.agent === 'claude') throw new CliError(`AI: cannot start: ${usable.reason}`);
                    io.out(`AI: not started (${usable.reason}); start it later with \`dt agent\``);
                } else {
                    agent = await deps
                        .startAgent({
                            ...agentOptions(cfg, 'claude'),
                            // the credential in memory: never on disk
                            connect: { credential: { url: server.agentUrl, token: server.agentToken, session: server.session } },
                            roles: AGENT_ROLES,
                            once: false,
                            log: (line) => io.out(`AI: ${line}`),
                        })
                        .catch((e: unknown) => {
                            if (!(e instanceof SessionError)) throw e;
                            if (opts.agent === 'claude') throw new CliError(`AI: cannot start: ${e.message}`);
                            io.out(`AI: not started (${e.message}); start it later with \`dt agent\``);
                            return undefined;
                        });
                    if (agent) io.out(`AI: started in this process (claude ${usable.version}; ${rolesText(agent.roles)})`);
                }
            }
        } catch (e) {
            await server.stop();
            throw e;
        }
        void agent?.done.then((end) => {
            if (end === 'lost') io.out('AI: stopped (the session server refused it); start it again with `dt agent`');
        });
        await server.closed;
        await agent?.stop();
        await server.stop();
        io.out('Session closed.');
    };

    /**
     * The startup lines of a server or an agent: the config files (`Config: domaintrail.jsonc + domaintrail.local.jsonc`),
     * a warning when git would commit the local override (with the line for `.gitignore`), and, when the AI reads
     * anything outside the workspace, what each role of `roles` reads there (one line each).
     */
    const printConfig = async (cfg: ResolvedConfig, roles: readonly AgentRole[] = AGENT_ROLES): Promise<void> => {
        const shown = (file: string): string => path.relative(process.cwd(), file) || file;
        const files = [cfg.file, cfg.localFile].filter((f): f is string => f !== undefined);
        if (files.length) io.out(`Config: ${files.map(shown).join(' + ')}`);
        if (cfg.localFile) {
            const state = await deps.localConfigState?.(cfg.localFile).catch(() => undefined);
            const name = path.basename(cfg.localFile);
            const ignoreFile = shown(path.join(path.dirname(cfg.localFile), '.gitignore'));
            if (state === 'tracked')
                io.err(
                    `Warning: ${shown(cfg.localFile)} is tracked by git, and it is your own: \`git rm --cached ${name}\`, then add this line to ${ignoreFile}: ${name}`,
                );
            else if (state === 'unignored')
                io.err(`Warning: ${shown(cfg.localFile)} is not ignored by git, and it is your own: add this line to ${ignoreFile}: ${name}`);
        }
        for (const line of readScopeLines(cfg, roles)) io.out(line);
    };

    /** Starts only with approved security-relevant settings (`approveSettings`); refused: a one-line error. */
    const approve = async (cfg: ResolvedConfig, yes: boolean | undefined, flags: StartFlags = {}): Promise<void> => {
        await approveSettings(
            cfg,
            { ...(deps.trust && { trust: deps.trust }), ...(deps.confirm && { confirm: (q: string) => deps.confirm!(q) }), out: io.out },
            yes ?? false,
            flags,
        ).catch((e: unknown) => {
            if (e instanceof NotApproved) throw new CliError(e.message);
            throw e;
        });
    };

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

/** The options of `dt open` and `dt collab`. */
interface ServeOptions {
    port?: number;
    host?: string;
    base?: string;
    /** `false` with `--no-agent`, `claude` given explicitly, else undefined (started when usable). */
    agent?: 'claude' | false;
    /** `--yes`: approve changed security-relevant settings without asking. */
    yes?: boolean;
}

/**
 * What the session server of `dt open` reads of `cfg`: its port and host, the dev identity, and nothing of
 * `collab.access` (`dt open` answers loopback only, never a tunnel's hosts).
 */
function openSettings(cfg: ResolvedConfig, port: number, host: string): SessionSettings {
    const { run } = cfg.agent;
    return {
        port,
        host,
        identity: 'dev',
        maxParticipants: 1,
        quickReactions: cfg.collab.quickReactions,
        agent: { port: cfg.agent.port, allowedTools: run.allowedTools, maxPreviousRunDiff: run.maxPreviousRunDiff },
        classifier: cfg.classifier,
        templates: cfg.templates,
    };
}

/** What the session server reads of `cfg`, its port and host from `server` with `--port` and `--host` applied. */
function sessionSettings(cfg: ResolvedConfig, server: { port: number; host: string }, opts: { port?: number; host?: string }): SessionSettings {
    const { run } = cfg.agent;
    return {
        ...cfg.collab,
        port: opts.port ?? server.port,
        host: opts.host ?? server.host,
        agent: { port: cfg.agent.port, allowedTools: run.allowedTools, maxPreviousRunDiff: run.maxPreviousRunDiff },
        classifier: cfg.classifier,
        templates: cfg.templates,
    };
}

/**
 * What each of `roles` reads outside the workspace (`agent.read.paths` and its own), one line each, when any role
 * reads anything there: none, nothing to say.
 */
export function readScopeLines(cfg: ResolvedConfig, roles: readonly AgentRole[], home: string = homedir()): string[] {
    const { read } = cfg.agent;
    if (!roles.some((r) => read[r].length)) return [];
    const shown = (p: string): string => {
        const rel = path.relative(home, p);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${toPosix(rel)}` : p;
    };
    return roles.map((role) => {
        const who = role === 'answer' ? 'AI answers read' : 'AI runs read (never write)';
        return read[role].length ? `${who} outside the workspace: ${read[role].map(shown).join(', ')}` : `${who} the workspace only`;
    });
}

/** The roles an agent took on, as the CLI prints them. */
const rolesText = (roles: readonly AgentRole[]): string => `role${roles.length > 1 ? 's' : ''} ${roles.join(', ')}`;

/** Whether `host` is a loopback address (or name): `dt open` serves the chat there only. */
function isLoopback(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * A command removed without an alias (ADR 0030): hidden from the help, it fails with `message` (exit 2), whatever it
 * is given. The removed subcommands are added to the command it returns.
 */
function removed(parent: Command, name: string, message: string): Command {
    return parent
        .command(name, { hidden: true })
        .helpOption(false)
        .allowUnknownOption()
        .allowExcessArguments()
        .argument('[args...]')
        .action(() => {
            throw new CliError(message, 2);
        });
}

/** The workspace as the servers and the export see it: the root, the sources and the config file. */
function workspaceOf(cfg: ResolvedConfig): SourcesExportOptions {
    return { root: cfg.root, sources: cfg.sources, respectGitignore: cfg.respectGitignore, ...(cfg.file !== undefined && { configFile: cfg.file }) };
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
