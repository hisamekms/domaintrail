// The file a running session server leaves in `.domaintrail/session/` for local processes (ADR 0026, S4; ADR 0030,
// M5): `server.json`, the public listener's and the agent API's addresses (for `dt collab link`, `dt collab
// agent-link` and `dt agent`), no secret. Written 0600 through a temporary file renamed into place, never through a
// symbolic link, and removed when the server stops. The agent API's credential is never written to disk: the agent in
// process gets it in memory, a standalone `dt agent` exchanges a one-time pairing code for it. `agent.json`, where
// older versions wrote it, is removed when a server starts (`removeLegacyAgentFile`).
import { lstat, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { checkPlain, replaceFile, sessionDirectory } from './session-dir.js';

/** Where older versions wrote the agent API's credential: removed, never written or read. */
export const LEGACY_AGENT_FILE = 'agent.json';
export const SERVER_FILE = 'server.json';

/** The agent API's address (loopback) and the bearer token it requires: held in memory only. */
export interface AgentCredential {
    readonly url: string;
    readonly token: string;
    readonly session: string;
}

/** `server.json`: where the session's page and its agent API are served. */
export interface ServerAddress {
    readonly url: string;
    /** The agent API (loopback); absent in a file of an older version. */
    readonly agentUrl?: string;
    readonly session: string;
    readonly pid: number;
}

async function writeJson(root: string, name: string, value: object): Promise<string> {
    const file = path.join(await sessionDirectory(root), name);
    await checkPlain(file, 'file');
    await replaceFile(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
    return file;
}

async function readJson(root: string, name: string): Promise<unknown> {
    const file = path.join(path.resolve(root), '.domaintrail', 'session', name);
    if ((await checkPlain(file, 'file')) === 'absent') return undefined;
    return JSON.parse(await readFile(file, 'utf8'));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const writeServerAddress = (root: string, address: ServerAddress): Promise<string> => writeJson(root, SERVER_FILE, address);

/** The address of the session server running on the workspace, if any. */
export async function readServerAddress(root: string): Promise<ServerAddress | undefined> {
    const v = await readJson(root, SERVER_FILE);
    if (!isObject(v) || typeof v.url !== 'string' || typeof v.session !== 'string' || typeof v.pid !== 'number') return undefined;
    return { url: v.url, ...(typeof v.agentUrl === 'string' && { agentUrl: v.agentUrl }), session: v.session, pid: v.pid };
}

/** Removes the `agent.json` an older version left (a credential on disk), whoever wrote it; not through a link. */
export async function removeLegacyAgentFile(root: string): Promise<boolean> {
    const file = path.join(path.resolve(root), '.domaintrail', 'session', LEGACY_AGENT_FILE);
    const stat = await lstat(file).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
        throw e;
    });
    if (!stat) return false;
    await unlink(file);
    return true;
}

/** Removes the files this process wrote (a file of another server's process is left alone). */
export async function removeSessionFiles(root: string, pid: number): Promise<void> {
    for (const name of [SERVER_FILE]) {
        const file = path.join(path.resolve(root), '.domaintrail', 'session', name);
        const stat = await lstat(file).catch((e: unknown) => {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
            throw e;
        });
        if (!stat?.isFile()) continue;
        const v = await readJson(root, name);
        if (isObject(v) && v.pid === pid) await unlink(file);
    }
}
