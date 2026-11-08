// The app's own settings in domaintrail.jsonc (ADR 0027, Project analysis and configuration: `apps/dt` owns the port
// and host; Authorization: the Host and Origin connection guards are the app's; ADR 0030: the sections): `open.port`,
// `open.host`, `collab.port`, `collab.host`, `agent.port`, `collab.access.allowedHosts` and
// `collab.access.allowedOrigins`.

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';

/** The app's keys, by where they sit in the file (`''`: the top level). */
export const SERVER_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['open', 'agent'],
    open: ['port', 'host'],
    collab: ['port', 'host'],
    'collab.access': ['allowedHosts', 'allowedOrigins'],
    agent: ['port'],
};

/** The app's part of `collab.access` in the config file: what the server answers to besides loopback. */
export interface AccessGuardsConfigFile {
    /** Host names the server answers to besides loopback. Default: none. */
    allowedHosts?: string[];
    /** Origins (`https://host[:port]`) whose pages may call the server besides loopback. Default: none. */
    allowedOrigins?: string[];
}

/** The `open` section in the config file (`dt open`). */
export interface OpenConfigFile {
    open?: { port?: number; host?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
export const isPort = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;

/** Checks `open` of the config file's top level; `fail` throws. */
export function validateOpenConfig(config: Record<string, unknown>, fail: (msg: string) => never): void {
    const open = config.open;
    if (open === undefined) return;
    if (!isObject(open)) return fail("'open' must be an object");
    for (const key of Object.keys(open)) if (!SERVER_CONFIG_KEYS.open.includes(key)) fail(`unknown key 'open.${key}'`);
    if (open.port !== undefined && !isPort(open.port)) fail("'open.port' must be a port number");
    if (open.host !== undefined && (typeof open.host !== 'string' || !open.host)) fail("'open.host' must be a string");
}

/** `open` with its defaults (validated). */
export function resolveOpenConfig(config: OpenConfigFile = {}): { port: number; host: string } {
    return { port: config.open?.port ?? DEFAULT_PORT, host: config.open?.host ?? DEFAULT_HOST };
}

/** Checks `collab.port` and `collab.host`. */
export function validateCollabServerConfig(collab: Record<string, unknown>, fail: (msg: string) => never): void {
    if (collab.port !== undefined && !isPort(collab.port)) fail("'collab.port' must be a port number");
    if (collab.host !== undefined && (typeof collab.host !== 'string' || !collab.host)) fail("'collab.host' must be a string");
}

/** Checks `agent.port`: the agent API's, on 127.0.0.1 only. */
export function validateAgentApiConfig(agent: Record<string, unknown>, fail: (msg: string) => never): void {
    if (agent.port !== undefined && !isPort(agent.port)) fail("'agent.port' must be a port number");
}

/** The checks of the app's keys of `collab.access` (an object), by key; run with Collaboration's in one order. */
export const ACCESS_GUARD_CHECKS: Readonly<Record<string, (access: Record<string, unknown>, fail: (msg: string) => never) => void>> = {
    allowedHosts: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.allowedHosts === undefined) return;
        if (!isStringList(access.allowedHosts)) return fail("'collab.access.allowedHosts' must be an array of host names");
        for (const h of access.allowedHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'collab.access.allowedHosts' must hold host names only: '${h}'`);
    },
    allowedOrigins: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.allowedOrigins === undefined) return;
        if (!isStringList(access.allowedOrigins)) return fail("'collab.access.allowedOrigins' must be an array of origins");
        for (const o of access.allowedOrigins) {
            const origin = URL.canParse(o) ? new URL(o) : undefined;
            if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== o)
                fail(`'collab.access.allowedOrigins' must hold origins like 'https://example.com': '${o}'`);
        }
    },
};

/** The app's part of `collab.access` with its defaults (validated). */
export function resolveAccessGuards(access: AccessGuardsConfigFile): { allowedHosts: string[]; allowedOrigins: string[] } {
    return { allowedHosts: access.allowedHosts ?? [], allowedOrigins: access.allowedOrigins ?? [] };
}
