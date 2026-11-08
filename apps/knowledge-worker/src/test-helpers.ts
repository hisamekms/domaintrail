// The Worker in workerd for the unit tests: bundled from src/worker.ts as `wrangler deploy` would bundle the shipped
// worker.js, run by Miniflare with a local D1 and R2 and the bindings of template/wrangler.jsonc, its migrations
// applied, and listening on a loopback port.
import * as path from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from './env.js';

const ROOT = path.join(import.meta.dir, '..');
const TEMPLATE = path.join(ROOT, 'template');

interface WranglerConfig {
    compatibility_date: string;
    assets: { directory: string; binding: string };
    d1_databases: { binding: string }[];
    r2_buckets: { binding: string }[];
    triggers: { crons: string[] };
    vars: Record<string, string>;
}

export interface RunningWorker {
    readonly url: string;
    readonly db: D1Database;
    readonly config: WranglerConfig;
    /** Runs the Cron Trigger as if at `time`. */
    scheduled(time: Date): Promise<void>;
    dispose(): Promise<void>;
}

let bundled: Promise<string> | undefined;
/** The Worker bundled once per test process. */
function bundle(): Promise<string> {
    bundled ??= (async (): Promise<string> => {
        const built = await Bun.build({ entrypoints: [path.join(ROOT, 'src', 'worker.ts')], target: 'browser', format: 'esm' });
        if (!built.success) throw new Error(built.logs.map((l) => l.message).join('\n'));
        return built.outputs[0].text();
    })();
    return bundled;
}

/** The statements of a migration file: its `;`-ended statements without the comments. */
export function statementsOf(sql: string): string[] {
    return sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter(Boolean);
}

export interface StartOptions {
    /** Apply the template's migrations (default true). */
    readonly migrate?: boolean;
    /** The directory of the page's files, served as the Worker's static assets (the built `page/`); none by default. */
    readonly page?: string;
    /** The port to listen on (default: any free one). */
    readonly port?: number;
}

/** Starts the Worker with the template's bindings, `vars` over its variables, and (unless `migrate: false`) its schema. */
export async function startWorker(vars: Record<string, string> = {}, options: StartOptions = {}): Promise<RunningWorker> {
    const config = Bun.JSONC.parse(await Bun.file(path.join(TEMPLATE, 'wrangler.jsonc')).text()) as WranglerConfig;
    const mf = new Miniflare({
        modules: true,
        script: await bundle(),
        compatibilityDate: config.compatibility_date,
        d1Databases: config.d1_databases.map((d) => d.binding),
        r2Buckets: config.r2_buckets.map((r) => r.binding),
        bindings: { ...config.vars, ...vars },
        ...(options.page !== undefined && {
            assets: {
                directory: options.page,
                binding: config.assets.binding,
                routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            },
        }),
        host: '127.0.0.1',
        port: options.port ?? 0,
    });
    const url = (await mf.ready).toString().replace(/\/$/, '');
    const db = (await mf.getD1Database('DB')) as unknown as D1Database;
    if (options.migrate !== false) {
        const files = [...new Bun.Glob('*.sql').scanSync(path.join(TEMPLATE, 'migrations'))].sort();
        for (const file of files) {
            const sql = await Bun.file(path.join(TEMPLATE, 'migrations', file)).text();
            await db.batch(statementsOf(sql).map((s) => db.prepare(s)));
        }
    }
    return {
        url,
        db,
        config,
        async scheduled(time) {
            // the Fetcher of workerd, typed by @cloudflare/workers-types, which this repository does not install
            const worker = (await mf.getWorker()) as unknown as { scheduled(event: { scheduledTime: Date; cron: string }): Promise<unknown> };
            await worker.scheduled({ scheduledTime: time, cron: config.triggers.crons[0] });
        },
        dispose: () => mf.dispose(),
    };
}
