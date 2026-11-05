// What the Worker is given by Cloudflare: its bindings (template/wrangler.jsonc) and its variables. The binding types
// are the part of the Workers runtime's D1, R2 and Cron Trigger APIs that the Worker uses, written here rather than
// taken from @cloudflare/workers-types, whose globals clash with the DOM and Bun types of the repository's single
// tsconfig. Miniflare (the tests) and Cloudflare give the real ones, which have these members.

export interface D1Result<T = Record<string, unknown>> {
    readonly results: T[];
    readonly success: boolean;
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run(): Promise<D1Result>;
}

export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    /** The statements in one transaction: one failing rolls them all back and rejects. */
    batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
    readonly httpMetadata?: { readonly contentType?: string };
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
    put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
    get(key: string): Promise<R2ObjectBody | null>;
    /** Up to 1000 keys at once; a missing key is no error. */
    delete(keys: string | string[]): Promise<void>;
}

export interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
}

export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}

/** A binding that answers requests: the static assets of the read-only page (Workers Static Assets). */
export interface Fetcher {
    fetch(request: Request): Promise<Response>;
}

/** The bindings and variables of template/wrangler.jsonc. */
export interface Env {
    /** The D1 database: items, versions, sources, audit, redactions, projects and members (template/migrations). */
    readonly DB: D1Database;
    /** The R2 bucket of the images, by `<project>/<image id>`. */
    readonly IMAGES: R2Bucket;
    /** The read-only page's files (`page/`: its HTML, script and styles), served behind the Worker's own Access check. */
    readonly ASSETS?: Fetcher;
    /** `<team>.cloudflareaccess.com`: the issuer of the Access tokens the Worker verifies. */
    readonly ACCESS_TEAM_DOMAIN?: string;
    /** The Access application's audience tag (AUD). */
    readonly ACCESS_AUD?: string;
    /** The Client IDs of the service tokens that may write, comma-separated; any other service token only reads. */
    readonly WRITER_TOKENS?: string;
    /**
     * `"true"` trusts the identity headers without verifying a token: for `wrangler dev` and the tests only. Without it
     * and without the two Access settings, the Worker refuses every call.
     */
    readonly INSECURE_SKIP_ACCESS_CHECK?: string;
    /** How long a deleted item waits for the sweep, in seconds (after the page's 10 s of 元に戻す). Default: 60. */
    readonly SWEEP_AFTER_SECONDS?: string;
}
