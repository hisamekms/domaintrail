// The file a running session server leaves in the session's directory (the workspace's state directory, outside the
// workspace) for local processes (ADR 0026, S4; ADR 0030, M5): `server.json`, the public listener's and the agent
// API's addresses (for `dt open link`, `dt collab link`, `dt collab agent-link` and `dt agent`), no secret. Written
// 0600 through a temporary file renamed into place, never through a symbolic link, and removed when the server stops.
// The agent API's credential is never written to disk: the agent in process gets it in memory, a standalone `dt agent`
// exchanges a one-time pairing code for it (the `agent.json` older versions wrote in `.domaintrail/session/` is
// deleted when that directory is moved).
import { lstat, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { checkPlain, replaceFile, sessionDirectory } from './session-dir.js';

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
    /** The public origin of a `link` session (a tunnel's): the links printed by other commands are made with it. */
    readonly publicUrl?: string;
    readonly session: string;
    readonly pid: number;
}

async function writeJson(dir: string, name: string, value: object): Promise<string> {
    const file = path.join(await sessionDirectory(dir), name);
    await checkPlain(file, 'file');
    await replaceFile(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
}

async function readJson(dir: string, name: string): Promise<unknown> {
    const file = path.join(dir, name);
    if ((await checkPlain(file, 'file')) === 'absent') return undefined;
    return JSON.parse(await readFile(file, 'utf8'));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Writes `server.json` in the session's directory `dir`. */
export const writeServerAddress = (dir: string, address: ServerAddress): Promise<string> => writeJson(dir, SERVER_FILE, address);

/** The address of the session server running on the workspace whose session's directory is `dir`, if any. */
export async function readServerAddress(dir: string): Promise<ServerAddress | undefined> {
    const v = await readJson(dir, SERVER_FILE);
    if (!isObject(v) || typeof v.url !== 'string' || typeof v.session !== 'string' || typeof v.pid !== 'number') return undefined;
    return {
        url: v.url,
        ...(typeof v.agentUrl === 'string' && { agentUrl: v.agentUrl }),
        ...(typeof v.publicUrl === 'string' && { publicUrl: v.publicUrl }),
        session: v.session,
        pid: v.pid,
    };
}

/** Removes the files this process wrote (a file of another server's process is left alone). */
export async function removeSessionFiles(dir: string, pid: number): Promise<void> {
    for (const name of [SERVER_FILE]) {
        const file = path.join(dir, name);
        const stat = await lstat(file).catch((e: unknown) => {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
            throw e;
        });
        if (!stat?.isFile()) continue;
        const v = await readJson(dir, name);
        if (isObject(v) && v.pid === pid) await unlink(file);
    }
}
