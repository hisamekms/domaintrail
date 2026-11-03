// The approval of a workspace's security-relevant settings (the maintainer's decision of 2026-11-03, after the
// security review of the read paths): what the AI may read or run and who may reach the session come from files a
// commit (the project's config) or anyone with write access to the workspace (the local override, which git ignores)
// can change, so `dt open`, `dt collab` and `dt agent` show the effective settings — the project's config merged with
// the local override — and ask before starting with settings not approved before for this workspace. The approvals
// are kept outside the workspace (`trust.json` under the user's XDG config directory: `fileTrustStore`), by the
// workspace's real path, as a hash of the settings (`settingsHash`). Settings that are all the defaults need no
// approval.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { defaultConfig, type ResolvedConfig } from '../config/config.js';

/** Where the approvals are kept: what the CLI asks of it. */
export interface TrustStore {
    /** The hash approved for the workspace at `workspace` (its real path), if any. */
    approved(workspace: string): Promise<string | undefined>;
    /** Records `hash` as approved for `workspace`. */
    approve(workspace: string, hash: string): Promise<void>;
}

/** What a command adds to the settings of the file: `dt collab --tunnel` (a public quick tunnel, the `link` identity). */
export interface StartFlags {
    readonly tunnel?: boolean;
}

/**
 * The security-relevant settings of `cfg`, effective (merged), with their keys: what each role reads outside the
 * workspace, the runner's tools and its `dt`; who may reach the session (`collab.identity`, `collab.host`,
 * `collab.access`, `collab.link`, `open.host`, and `--tunnel`: the session on the internet); and where the addressed
 * messages are sent (`classifier`, but its threshold). `collab.link` and the tunnel are there only when set, so that
 * the settings approved before them keep their hash.
 */
export function securitySettings(cfg: ResolvedConfig, flags: StartFlags = {}): Record<string, unknown> {
    const { threshold: _threshold, ...classifier } = cfg.classifier;
    return {
        'agent.read (answer)': cfg.agent.read.answer,
        'agent.read (run)': cfg.agent.read.run,
        'agent.run.allowedTools': cfg.agent.run.allowedTools,
        'agent.run.dt': cfg.agent.run.dt ?? null,
        'collab.identity': cfg.collab.identity,
        'collab.host': cfg.collab.host,
        'collab.access': cfg.collab.access ?? null,
        ...(cfg.collab.link && { 'collab.link': cfg.collab.link }),
        ...(flags.tunnel && { 'collab --tunnel': 'a public cloudflared quick tunnel (trycloudflare.com), identity link' }),
        'open.host': cfg.open.host,
        classifier,
    };
}

/** JSON with the keys of every object sorted: the same settings, the same text. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value !== null)
        return `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

/** The hash of security settings (SHA-256 of their canonical JSON). */
export function settingsHash(settings: Record<string, unknown>): string {
    return createHash('sha256').update(canonical(settings)).digest('hex');
}

/** The settings as the CLI prints them, one line each. */
export function settingsLines(settings: Record<string, unknown>): string[] {
    return Object.entries(settings).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
}

/** The approvals file: `$XDG_CONFIG_HOME/domaintrail/trust.json`, by default `~/.config/domaintrail/trust.json` (macOS too). */
export function trustFile(env: NodeJS.ProcessEnv = process.env): string {
    const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir(), '.config');
    return path.join(base, 'domaintrail', 'trust.json');
}

interface TrustFile {
    version: 1;
    workspaces: Record<string, { hash: string; approvedAt: string }>;
}

/** The approvals in `file` (absent, or not one: none). */
async function readTrust(file: string): Promise<TrustFile> {
    try {
        const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (typeof raw === 'object' && raw !== null && 'workspaces' in raw && typeof raw.workspaces === 'object' && raw.workspaces !== null)
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each entry is checked when read
            return { version: 1, workspaces: raw.workspaces as TrustFile['workspaces'] };
    } catch {
        // missing or not JSON: no approval
    }
    return { version: 1, workspaces: {} };
}

/** The approvals file of the user (`trustFile`): its directory 0700, the file 0600, written whole then renamed. */
export function fileTrustStore(file: string = trustFile()): TrustStore {
    return {
        async approved(workspace) {
            const entry = (await readTrust(file)).workspaces[workspace];
            return typeof entry?.hash === 'string' ? entry.hash : undefined;
        },
        async approve(workspace, hash) {
            const dir = path.dirname(file);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await chmod(dir, 0o700);
            const trust = await readTrust(file);
            trust.workspaces[workspace] = { hash, approvedAt: new Date().toISOString() };
            const temporary = `${file}.${process.pid}.tmp`;
            await writeFile(temporary, `${JSON.stringify(trust, null, 2)}\n`, { mode: 0o600 });
            await chmod(temporary, 0o600);
            await rename(temporary, file);
        },
    };
}

/** What `approveSettings` asks of the CLI. */
export interface ApprovalDeps {
    readonly trust?: TrustStore;
    /** Asks the person (a terminal); absent: no one to ask. */
    readonly confirm?: (question: string) => Promise<boolean>;
    readonly out: (line: string) => void;
}

/** Why a start was refused: the settings were not approved. */
export class NotApproved extends Error {}

/**
 * Starts only with approved settings: all defaults, or the hash approved for this workspace; else prints them and
 * asks (`confirm`), or records them with `yes` (`--yes`). Refused (`NotApproved`) when declined, or with no one to ask
 * and no `--yes`. Without a store (a test's dependencies), nothing is asked.
 */
export async function approveSettings(cfg: ResolvedConfig, deps: ApprovalDeps, yes: boolean, flags: StartFlags = {}): Promise<void> {
    if (!deps.trust) return;
    const settings = securitySettings(cfg, flags);
    const hash = settingsHash(settings);
    if (hash === settingsHash(securitySettings(defaultConfig(cfg.root)))) return;
    let workspace: string;
    try {
        workspace = realpathSync.native(cfg.root);
    } catch {
        workspace = path.resolve(cfg.root);
    }
    if ((await deps.trust.approved(workspace)) === hash) return;
    deps.out(`Security-relevant settings not yet approved for this workspace (${workspace}):`);
    for (const line of settingsLines(settings)) deps.out(line);
    if (!yes) {
        if (!deps.confirm) throw new NotApproved('Not started: approve these settings in a terminal, or pass --yes.');
        if (!(await deps.confirm('Start with these settings? [y/N] '))) throw new NotApproved('Not started: the settings were not approved.');
    }
    await deps.trust.approve(workspace, hash);
    deps.out('Approved for this workspace.');
}
