// The session's persistence on node:sqlite (ADR 0026): one database per workspace, `.domaintrail/session/session.db`.
// Aggregates are stored whole as JSON next to the columns the queries and constraints need; the outbox is a table
// appended in the transaction that saves the aggregates. Every transaction is BEGIN IMMEDIATE, one at a time.
// Only node:sqlite's DatabaseSync is used (no Bun API), so the same code runs in the CLI on Node and in the tests on Bun.
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import * as path from 'node:path';
import type { Collaboration } from '../generated/index.js';
import type {
    EventOutbox,
    Lease,
    OutboxEntry,
    RequestRepository,
    RevisionStore,
    RunQueue,
    SessionRepository,
    StoredRun,
    Stores,
    UnitOfWork,
} from '../application/ports.js';
import { DATABASE_FILE, checkPlain, sessionDirectory } from './session-dir.js';

/**
 * The schema, one migration per entry: the database's `user_version` is the number applied. Never edit an applied
 * migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
    `
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX requests_by_session ON requests(session_id, seq);

    -- the run queue: a lease is an owner, a secret token and an expiry (ms since the epoch)
    CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at INTEGER,
        completed_with TEXT,
        CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL) AND (lease_token IS NULL) = (lease_owner IS NULL))
    ) STRICT;
    CREATE INDEX agent_runs_queue ON agent_runs(session_id, state, seq);
    CREATE INDEX agent_runs_leases ON agent_runs(lease_expires_at) WHERE lease_token IS NOT NULL;
    -- serial: one running run and one lease per session, whatever the code above does
    CREATE UNIQUE INDEX agent_runs_one_running ON agent_runs(session_id) WHERE state = 'Running';
    CREATE UNIQUE INDEX agent_runs_one_lease ON agent_runs(session_id) WHERE lease_token IS NOT NULL;

    -- the requests a run bundles (many to many)
    CREATE TABLE run_requests (
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        request_id TEXT NOT NULL REFERENCES requests(id),
        PRIMARY KEY (run_id, request_id)
    ) STRICT;
    CREATE INDEX run_requests_by_request ON run_requests(request_id);

    -- a revision's files are in data; their bytes are blobs by content hash (.domaintrail/session/blobs)
    CREATE TABLE revisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        origin TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX revisions_by_session ON revisions(session_id, seq);
    CREATE INDEX revisions_by_content ON revisions(content_hash);

    CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX outbox_by_session ON outbox(session_id, seq);
    `,
];

/** The database was written by a newer DomainTrail: its schema is unknown here. */
export class NewerSchema extends Error {}

/** Applies the migrations the database does not have yet, each in its own transaction. */
export function migrate(db: DatabaseSync): void {
    const version = Number(row(db.prepare('PRAGMA user_version').get()).user_version);
    if (version > MIGRATIONS.length) throw new NewerSchema(`The session database has schema version ${version}; this DomainTrail knows ${MIGRATIONS.length}.`);
    for (let v = version; v < MIGRATIONS.length; v++) {
        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(MIGRATIONS[v]);
            db.exec(`PRAGMA user_version = ${v + 1}`);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}

/** Opens (and migrates) a database: a file, or `:memory:`. */
export function openDatabase(file: string): DatabaseSync {
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA busy_timeout = 5000');
        if (file !== ':memory:') {
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA synchronous = NORMAL');
        }
        migrate(db);
        return db;
    } catch (e) {
        db.close();
        throw e;
    }
}

/**
 * Opens the session database of a workspace, `.domaintrail/session/session.db`, making the directory (with its
 * `.gitignore`) if needed. Refuses (`UnsafeSessionPath`) when the directory, the database or its WAL files are
 * symbolic links.
 */
export async function openSessionDatabase(root: string): Promise<DatabaseSync> {
    const dir = await sessionDirectory(root);
    const file = path.join(dir, DATABASE_FILE);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) await checkPlain(f, 'file');
    return openDatabase(file);
}

// ---- Rows and JSON ----

type Row = Record<string, SQLOutputValue>;

/** A row of a query; throws when there is none. */
function row(r: Row | undefined): Row {
    if (!r) throw new Error('Expected a row');
    return r;
}

function text(r: Row, column: string): string {
    const v = r[column];
    if (typeof v !== 'string') throw new Error(`Column ${column} is not text`);
    return v;
}

function optionalText(r: Row, column: string): string | undefined {
    const v = r[column];
    if (v === null || v === undefined) return undefined;
    if (typeof v !== 'string') throw new Error(`Column ${column} is not text`);
    return v;
}

function integer(r: Row, column: string): number {
    const v = r[column];
    if (typeof v === 'bigint') return Number(v);
    if (typeof v !== 'number') throw new Error(`Column ${column} is not an integer`);
    return v;
}

/** JSON with dates kept as dates: `{"$date": "<ISO>"}`. */
export function encodeJson(value: unknown): string {
    return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown): unknown {
        const raw = this[key];
        return raw instanceof Date ? { $date: raw.toISOString() } : v;
    });
}

export function decodeJson(json: string): unknown {
    return JSON.parse(json, (_key, v: unknown) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            const keys = Object.keys(v);
            if (keys.length === 1 && keys[0] === '$date') {
                const iso: unknown = Object.values(v)[0];
                if (typeof iso === 'string') return new Date(iso);
            }
        }
        return v;
    });
}

/** An aggregate or event of our own rows: written by `encodeJson` from a value of that type. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own rows, written from values of the type by the stores below
const decoded = <T>(json: string): T => decodeJson(json) as T;

const params = (values: Record<string, SQLInputValue>): Record<string, SQLInputValue> => values;

// ---- Stores ----

function sessions(db: DatabaseSync): SessionRepository {
    const load = db.prepare('SELECT data FROM sessions WHERE id = :id');
    const save = db.prepare(
        'INSERT INTO sessions (id, state, data) VALUES (:id, :state, :data) ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data',
    );
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Session>(text(r, 'data')) : undefined;
        },
        save(session) {
            save.run(params({ id: session.id, state: session.state, data: encodeJson(session) }));
        },
    };
}

function requests(db: DatabaseSync): RequestRepository {
    const load = db.prepare('SELECT data FROM requests WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO requests (id, session_id, seq, state, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM requests), :state, :data)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    );
    const list = db.prepare('SELECT data FROM requests WHERE session_id = :session ORDER BY seq');
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Request>(text(r, 'data')) : undefined;
        },
        save(request) {
            save.run(params({ id: request.id, session: request.session, state: request.state, data: encodeJson(request) }));
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.Request>(text(r, 'data')));
        },
    };
}

function storedRun(r: Row): StoredRun {
    const token = optionalText(r, 'lease_token');
    const lease: Lease | undefined =
        token === undefined ? undefined : { owner: text(r, 'lease_owner'), token, expiresAt: new Date(integer(r, 'lease_expires_at')) };
    return { run: decoded<Collaboration.AgentRun>(text(r, 'data')), lease, completedWith: optionalText(r, 'completed_with') };
}

function runs(db: DatabaseSync): RunQueue {
    const columns = 'data, lease_owner, lease_token, lease_expires_at, completed_with';
    const insert = db.prepare(
        `INSERT INTO agent_runs (id, session_id, seq, state, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_runs), :state, :data)`,
    );
    const bundle = db.prepare('INSERT INTO run_requests (run_id, request_id) VALUES (:run, :request)');
    const load = db.prepare(`SELECT ${columns} FROM agent_runs WHERE id = :id`);
    const save = db.prepare('UPDATE agent_runs SET state = :state, data = :data WHERE id = :id');
    const list = db.prepare('SELECT data FROM agent_runs WHERE session_id = :session ORDER BY seq');
    const active = db.prepare(
        `SELECT ${columns} FROM agent_runs
         WHERE session_id = :session AND (state = 'Running' OR (lease_token IS NOT NULL AND lease_expires_at > :now))
         ORDER BY seq LIMIT 1`,
    );
    const dropExpiredClaims = db.prepare(
        `UPDATE agent_runs SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE session_id = :session AND state = 'Queued' AND lease_token IS NOT NULL AND lease_expires_at <= :now`,
    );
    // the claim: one update of the first queued run without a lease, when the session has no running run or live lease
    const claim = db.prepare(
        `UPDATE agent_runs SET lease_owner = :owner, lease_token = :token, lease_expires_at = :expires
         WHERE id = (SELECT id FROM agent_runs WHERE session_id = :session AND state = 'Queued' AND lease_token IS NULL ORDER BY seq LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM agent_runs
                           WHERE session_id = :session AND (state = 'Running' OR (lease_token IS NOT NULL AND lease_expires_at > :now)))
         RETURNING id`,
    );
    const extend = db.prepare('UPDATE agent_runs SET lease_expires_at = :expires WHERE id = :id AND lease_token = :token AND lease_expires_at > :now');
    const release = db.prepare(
        `UPDATE agent_runs SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE id = :id AND lease_token = :token AND state = 'Queued'`,
    );
    const endLease = db.prepare(
        `UPDATE agent_runs SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_with = :completed WHERE id = :id`,
    );
    const expired = db.prepare(`SELECT ${columns} FROM agent_runs WHERE lease_token IS NOT NULL AND lease_expires_at <= :now ORDER BY seq`);
    return {
        enqueue(run) {
            insert.run(params({ id: run.id, session: run.session, state: run.state, data: encodeJson(run) }));
            for (const r of run.input.requests) bundle.run(params({ run: run.id, request: r.request }));
        },
        load(id) {
            const r = load.get(params({ id }));
            return r ? storedRun(r) : undefined;
        },
        save(run) {
            if (save.run(params({ id: run.id, state: run.state, data: encodeJson(run) })).changes !== 1) throw new Error(`Run ${run.id} was never queued`);
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.AgentRun>(text(r, 'data')));
        },
        active(session, now) {
            const r = active.get(params({ session, now: now.getTime() }));
            return r ? storedRun(r) : undefined;
        },
        claimNext(session, lease, now) {
            dropExpiredClaims.run(params({ session, now: now.getTime() }));
            const r = claim.get(params({ session, now: now.getTime(), owner: lease.owner, token: lease.token, expires: lease.expiresAt.getTime() }));
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the ID of a run row, written from an AgentRunId
            return r ? (text(r, 'id') as Collaboration.AgentRunId) : undefined;
        },
        extend(id, token, now, expiresAt) {
            return extend.run(params({ id, token, now: now.getTime(), expires: expiresAt.getTime() })).changes === 1;
        },
        release(id, token) {
            return release.run(params({ id, token })).changes === 1;
        },
        endLease(id, completedWith) {
            endLease.run(params({ id, completed: completedWith ?? null }));
        },
        expired(now) {
            return expired.all(params({ now: now.getTime() })).map(storedRun);
        },
    };
}

function revisions(db: DatabaseSync): RevisionStore {
    const load = db.prepare('SELECT data FROM revisions WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO revisions (id, session_id, seq, state, origin, content_hash, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM revisions), :state, :origin, :hash, :data)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    );
    const list = db.prepare('SELECT data FROM revisions WHERE session_id = :session ORDER BY seq');
    const latest = db.prepare('SELECT data FROM revisions WHERE session_id = :session ORDER BY seq DESC LIMIT 1');
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Revision>(text(r, 'data')) : undefined;
        },
        save(revision) {
            save.run(
                params({
                    id: revision.id,
                    session: revision.session,
                    state: revision.state,
                    origin: revision.origin.kind,
                    hash: revision.contentHash,
                    data: encodeJson(revision),
                }),
            );
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.Revision>(text(r, 'data')));
        },
        latest(session) {
            const r = latest.get(params({ session }));
            return r ? decoded<Collaboration.Revision>(text(r, 'data')) : undefined;
        },
    };
}

function outbox(db: DatabaseSync): EventOutbox {
    const append = db.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (:session, :type, :payload, :at)');
    const all = db.prepare('SELECT seq, session_id, payload, recorded_at FROM outbox WHERE seq > :cursor ORDER BY seq LIMIT :limit');
    const ofSession = db.prepare(
        'SELECT seq, session_id, payload, recorded_at FROM outbox WHERE seq > :cursor AND session_id = :session ORDER BY seq LIMIT :limit',
    );
    const entry = (r: Row): OutboxEntry => ({
        seq: integer(r, 'seq'),
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the session of an outbox row, written from a SessionId
        session: text(r, 'session_id') as Collaboration.SessionId,
        event: decoded<Collaboration.PersistentEvent>(text(r, 'payload')),
        recordedAt: new Date(text(r, 'recorded_at')),
    });
    return {
        append(session, events, recordedAt) {
            for (const event of events) append.run(params({ session, type: event.type, payload: encodeJson(event), at: recordedAt.toISOString() }));
        },
        readAfter(cursor, limit, session) {
            const rows = session === undefined ? all.all(params({ cursor, limit })) : ofSession.all(params({ cursor, limit, session }));
            return rows.map(entry);
        },
    };
}

/** The stores over one database connection; use them inside a transaction of `createUnitOfWork`. */
export function createStores(db: DatabaseSync): Stores {
    return { sessions: sessions(db), requests: requests(db), runs: runs(db), revisions: revisions(db), outbox: outbox(db) };
}

/**
 * Transactions over one connection: BEGIN IMMEDIATE (the write lock up front, so two processes on one file wait
 * instead of failing on upgrade), COMMIT when the work returns, ROLLBACK when it throws. Transactions are queued, so
 * the work of one never interleaves with another's on this connection.
 */
export function createUnitOfWork(db: DatabaseSync): UnitOfWork {
    const stores = createStores(db);
    let tail: Promise<unknown> = Promise.resolve();
    return {
        transaction<T>(work: (stores: Stores) => T | Promise<T>): Promise<T> {
            const run = async (): Promise<T> => {
                db.exec('BEGIN IMMEDIATE');
                try {
                    const result = await work(stores);
                    db.exec('COMMIT');
                    return result;
                } catch (e) {
                    db.exec('ROLLBACK');
                    throw e;
                }
            };
            const next = tail.then(run);
            // the next transaction waits for this one whatever its outcome; the outcome itself goes to the caller
            tail = next.then(
                () => undefined,
                () => undefined,
            );
            return next;
        },
    };
}
