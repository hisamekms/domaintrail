// The files a running session server leaves in `.domaintrail/session/` for local processes (ADR 0026, S4):
// `agent.json`, the agent API's address and credential (for `dt session subscribe`), and `server.json`, the public
// listener's address (for `dt session link`). Both are written 0600 through a temporary file renamed into place, never
// through a symbolic link, and removed when the server stops.
import { lstat, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { checkPlain, replaceFile, sessionDirectory } from './session-dir.js';

export const AGENT_FILE = 'agent.json';
export const SERVER_FILE = 'server.json';

/** `agent.json`: where the agent API listens (loopback) and the bearer token it requires. */
export interface AgentCredential {
    readonly url: string;
    readonly token: string;
    readonly session: string;
    readonly pid: number;
}

/** `server.json`: where the session's page is served. */
export interface ServerAddress {
    readonly url: string;
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

export const writeAgentCredential = (root: string, credential: AgentCredential): Promise<string> => writeJson(root, AGENT_FILE, credential);

export const writeServerAddress = (root: string, address: ServerAddress): Promise<string> => writeJson(root, SERVER_FILE, address);

/** The agent credential of the session server running on the workspace, if any. */
export async function readAgentCredential(root: string): Promise<AgentCredential | undefined> {
    const v = await readJson(root, AGENT_FILE);
    if (!isObject(v) || typeof v.url !== 'string' || typeof v.token !== 'string' || typeof v.session !== 'string' || typeof v.pid !== 'number')
        return undefined;
    return { url: v.url, token: v.token, session: v.session, pid: v.pid };
}

/** The address of the session server running on the workspace, if any. */
export async function readServerAddress(root: string): Promise<ServerAddress | undefined> {
    const v = await readJson(root, SERVER_FILE);
    if (!isObject(v) || typeof v.url !== 'string' || typeof v.session !== 'string' || typeof v.pid !== 'number') return undefined;
    return { url: v.url, session: v.session, pid: v.pid };
}

/** Removes the files this process wrote (a file of another server's process is left alone). */
export async function removeSessionFiles(root: string, pid: number): Promise<void> {
    for (const name of [AGENT_FILE, SERVER_FILE]) {
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
