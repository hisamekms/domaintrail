// The app's own settings in domaintrail.jsonc (ADR 0027, Project analysis and configuration: `apps/dt` owns the port
// and host): `view.port`, `view.host`, `session.port`, `session.host` and `session.agent.port`.

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';

/** The app's keys, by where they sit in the file (`''`: the top level). */
export const SERVER_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['view'],
    view: ['port', 'host'],
    session: ['port', 'host'],
    'session.agent': ['port'],
};

/** The `view` section in the config file. */
export interface ViewConfigFile {
    view?: { port?: number; host?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
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
