// The app's own settings in domaintrail.jsonc (ADR 0027, Project analysis and configuration: `apps/dt` owns the port
// and host; Authorization: the Host and Origin connection guards are the app's): `view.port`, `view.host`,
// `session.port`, `session.host`, `session.agent.port`, `session.access.allowedHosts` and
// `session.access.allowedOrigins`.

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';

/** The app's keys, by where they sit in the file (`''`: the top level). */
export const SERVER_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['view'],
    view: ['port', 'host'],
    session: ['port', 'host'],
    'session.access': ['allowedHosts', 'allowedOrigins'],
    'session.agent': ['port'],
};

/** The app's part of `session.access` in the config file: what the server answers to besides loopback. */
export interface AccessGuardsConfigFile {
    /** Host names the server answers to besides loopback. Default: none. */
    allowedHosts?: string[];
    /** Origins (`https://host[:port]`) whose pages may call the server besides loopback. Default: none. */
    allowedOrigins?: string[];
}

/** The `view` section in the config file. */
export interface ViewConfigFile {
    view?: { port?: number; host?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
export const isPort = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;

/** Checks `view` of the config file's top level; `fail` throws. */
export function validateViewConfig(config: Record<string, unknown>, fail: (msg: string) => never): void {
    const view = config.view;
    if (view === undefined) return;
    if (!isObject(view)) return fail("'view' must be an object");
    if (view.port !== undefined && (typeof view.port !== 'number' || !Number.isInteger(view.port) || view.port < 0)) fail("'view.port' must be a port number");
    if (view.host !== undefined && typeof view.host !== 'string') fail("'view.host' must be a string");
}

/** `view` with its defaults (validated). */
export function resolveViewConfig(config: ViewConfigFile = {}): { port: number; host: string } {
    return { port: config.view?.port ?? DEFAULT_PORT, host: config.view?.host ?? DEFAULT_HOST };
}

/** Checks `session.port` and `session.host`. */
export function validateSessionServerConfig(session: Record<string, unknown>, fail: (msg: string) => never): void {
    if (session.port !== undefined && !isPort(session.port)) fail("'session.port' must be a port number");
    if (session.host !== undefined && (typeof session.host !== 'string' || !session.host)) fail("'session.host' must be a string");
}

/** Checks `session.agent.port`: the agent API's, on 127.0.0.1 only. */
export function validateAgentApiConfig(agent: Record<string, unknown>, fail: (msg: string) => never): void {
    if (agent.port !== undefined && !isPort(agent.port)) fail("'session.agent.port' must be a port number");
}

/** The checks of the app's keys of `session.access` (an object), by key; run with Collaboration's in one order. */
export const ACCESS_GUARD_CHECKS: Readonly<Record<string, (access: Record<string, unknown>, fail: (msg: string) => never) => void>> = {
    allowedHosts: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.allowedHosts === undefined) return;
        if (!isStringList(access.allowedHosts)) return fail("'session.access.allowedHosts' must be an array of host names");
        for (const h of access.allowedHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'session.access.allowedHosts' must hold host names only: '${h}'`);
    },
    allowedOrigins: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.allowedOrigins === undefined) return;
        if (!isStringList(access.allowedOrigins)) return fail("'session.access.allowedOrigins' must be an array of origins");
        for (const o of access.allowedOrigins) {
            const origin = URL.canParse(o) ? new URL(o) : undefined;
            if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== o)
                fail(`'session.access.allowedOrigins' must hold origins like 'https://example.com': '${o}'`);
        }
    },
};

/** The app's part of `session.access` with its defaults (validated). */
export function resolveAccessGuards(access: AccessGuardsConfigFile): { allowedHosts: string[]; allowedOrigins: string[] } {
    return { allowedHosts: access.allowedHosts ?? [], allowedOrigins: access.allowedOrigins ?? [] };
}
