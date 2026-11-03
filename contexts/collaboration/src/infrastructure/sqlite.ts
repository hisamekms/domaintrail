// The session's persistence on node:sqlite (ADR 0026): one database per workspace, `.domaintrail/session/session.db`.
// Aggregates are stored whole as JSON next to the columns the queries and constraints need; the outbox is a table
// appended in the transaction that saves the aggregates. Every transaction is BEGIN IMMEDIATE, one at a time.
// Only node:sqlite's DatabaseSync is used (no Bun API), so the same code runs in the CLI under Node and in the tests under Bun as well.
import { writeFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import * as path from 'node:path';
import type { Collaboration } from '../generated/index.js';
import type { Identity, IdentityKey, IdentityMode } from '../application/identity.js';
import { markKey, signKey } from '../domain/marks.js';
import type {
    AccessStore,
    EventOutbox,
    Lease,
    MarkRepository,
    ApprovalRepository,
    OutboxEntry,
    RequestRepository,
    RevisionStore,
    OperationLog,
    InterviewRepository,
    ProposalRepository,
    RestoreOperation,
    TriageRepository,
    RestoreResult,
    RunQueue,
    SessionRepository,
    StoredRun,
    Stores,
    UnitOfWork,
} from '../application/ports.js';
import { upgradeEvent, upgradeProposal, upgradeRequest, upgradeRun, upgradeSession } from './legacy.js';
import { DATABASE_FILE, PRIVATE_FILE, checkPlain, looserThan, restrict, sessionDirectory } from './session-dir.js';

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
    // who may act in a session (S4): the one-time facilitator links, the facilitator's identity, the dev sign-ins;
    // secrets are kept only as their SHA-256
    `
    CREATE TABLE facilitator_links (
        code_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        expires_at INTEGER NOT NULL,
        used_at INTEGER
    ) STRICT;

    CREATE TABLE facilitators (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id),
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        bound_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE sign_ins (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        identity TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
    ) STRICT;
    CREATE INDEX sign_ins_by_session ON sign_ins(session_id) WHERE revoked_at IS NULL;
    `,
    // every attempted restore (S7): who, which revision, the revisions it recorded, and how it ended
    `
    CREATE TABLE restore_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        participant TEXT NOT NULL,
        identity_provider TEXT,
        identity_subject TEXT,
        revision_id TEXT NOT NULL,
        manual_revision_id TEXT,
        pre_restore_id TEXT,
        restored_id TEXT,
        result TEXT NOT NULL CHECK (result IN ('Restored', 'Refused', 'Failed')),
        reason TEXT,
        detail TEXT,
        CHECK ((identity_provider IS NULL) = (identity_subject IS NULL))
    ) STRICT;
    CREATE INDEX restore_operations_by_session ON restore_operations(session_id, seq);
    `,
    // votes and reactions (ADR 0026, appendix "Votes and reactions"): a mark is kept when removed; at most one placed
    // mark per participant, target (its key, `markKey`) and sign
    `
    CREATE TABLE marks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        participant TEXT NOT NULL,
        target_key TEXT NOT NULL,
        sign TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX marks_placed ON marks(session_id, participant, seq) WHERE state = 'Placed';
    CREATE UNIQUE INDEX marks_one_placed ON marks(session_id, participant, target_key, sign) WHERE state = 'Placed';
    `,
    // ---------- replies to runs ----------
    // a message that replies to a run (ADR 0026, amendment "replies to runs"): the run it names, kept next to the JSON so
    // that the database refuses a reply to a run it does not hold; rows written before reply to none (NULL)
    `
    ALTER TABLE requests ADD COLUMN reply_to TEXT REFERENCES agent_runs(id);
    CREATE INDEX requests_by_reply_to ON requests(reply_to) WHERE reply_to IS NOT NULL;
    `,
    // ---------- reactions as emoji ----------
    // reactions are emoji the participants choose (ADR 0026, appendix "Votes and reactions"): a sign is the vote or a
    // reaction with its emoji (`{ "kind": "Reaction", "emoji": "👍" }`), and the `sign` column its key (`signKey`:
    // `Vote` or the emoji). The four named reactions become emoji — Agree 👍, Doubt 🤔, Like ❤️, Seen 👀 — in the
    // marks and in the outbox's MarkPlaced / MarkRemoved, so that a page replaying them reads the same signs. The
    // mapping is one to one: the unique index holds.
    `
    CREATE TEMP TABLE legacy_signs (name TEXT PRIMARY KEY, emoji TEXT NOT NULL);
    INSERT INTO legacy_signs VALUES ('Agree', '👍'), ('Doubt', '🤔'), ('Like', '❤️'), ('Seen', '👀');
    UPDATE marks
       SET data = json_set(data, '$.sign', json_object('kind', 'Reaction', 'emoji', (SELECT emoji FROM legacy_signs WHERE name = marks.sign))),
           sign = (SELECT emoji FROM legacy_signs WHERE name = marks.sign)
     WHERE sign IN (SELECT name FROM legacy_signs);
    UPDATE marks SET data = json_set(data, '$.sign', json_object('kind', 'Vote')) WHERE sign = 'Vote' AND json_type(data, '$.sign') = 'text';
    UPDATE outbox
       SET payload = json_set(payload, '$.sign', json(CASE json_extract(payload, '$.sign')
               WHEN 'Vote' THEN json_object('kind', 'Vote')
               ELSE json_object('kind', 'Reaction', 'emoji', (SELECT emoji FROM legacy_signs WHERE name = json_extract(payload, '$.sign')))
           END))
     WHERE type IN ('MarkPlaced', 'MarkRemoved') AND json_type(payload, '$.sign') = 'text'
       AND (json_extract(payload, '$.sign') = 'Vote' OR json_extract(payload, '$.sign') IN (SELECT name FROM legacy_signs));
    DROP TABLE legacy_signs;
    `,
    // ---------- replies to messages ----------
    // a message that replies to a message (ADR 0026, amendment "replies to messages"): the message it names, kept next
    // to the JSON so that the database refuses a reply to a message it does not hold; a reply to a run keeps its run in
    // `reply_to`. Rows written before reply to no message (NULL); their JSON names a run by its ID alone, read as a
    // reply to that run (`legacy.ts`)
    `
    ALTER TABLE requests ADD COLUMN reply_to_request TEXT REFERENCES requests(id);
    CREATE INDEX requests_by_reply_to_request ON requests(reply_to_request) WHERE reply_to_request IS NOT NULL;
    `,
    // ---------- approved assumptions ----------
    // the facilitator's approval of an assumption of a completed run (ADR 0026, amendment "Assumptions approved"): one
    // per run and assumption (its index in the reply). Sessions written before have none
    `
    CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        assumption INTEGER NOT NULL CHECK (assumption >= 0),
        data TEXT NOT NULL,
        UNIQUE (run_id, assumption)
    ) STRICT;
    CREATE INDEX approvals_by_session ON approvals(session_id, seq);
    `,
    // ---------- no confirmed revisions ----------
    // a revision is no longer confirmed (ADR 0026, amendment "Revisions are not confirmed"): a confirmed revision
    // becomes the recorded one it was, without who confirmed it and when, and the outbox's RevisionConfirmed events go
    `
    UPDATE revisions
       SET state = 'Recorded',
           data = json_remove(json_set(data, '$.state', 'Recorded'), '$.confirmedBy', '$.confirmedAt')
     WHERE state = 'Confirmed';
    DELETE FROM outbox WHERE type = 'RevisionConfirmed';
    `,
    // ---------- reverting a run ----------
    // a request that reverts a run's changes (ADR 0026, amendment "Revert a run"): the run it names, kept next to the JSON
    // so that the database refuses a revert of a run it does not hold. Rows written before revert none (NULL); their JSON
    // has no `reverts` and loads unchanged. The mechanical revert is a run like the others (state `Reverted`)
    `
    ALTER TABLE requests ADD COLUMN reverts TEXT REFERENCES agent_runs(id);
    CREATE INDEX requests_by_reverts ON requests(reverts) WHERE reverts IS NOT NULL;
    `,
    // ---------- modes, triage and change proposals ----------
    // ADR 0030: each message addressed to the AI has one triage (a unique index); a change proposal names its triage,
    // its message and, once approved, its run. The sessions and runs written before are read in the new shape
    // (`legacy.ts`: a session without a mode is Collab, a report's former booleans are Ran / Failed); nothing is rewritten
    `
    CREATE TABLE triages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
        state TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX triages_by_session ON triages(session_id, seq);

    CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        triage_id TEXT NOT NULL REFERENCES triages(id),
        request_id TEXT NOT NULL REFERENCES requests(id),
        run_id TEXT REFERENCES agent_runs(id),
        state TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX proposals_by_session ON proposals(session_id, seq);
    `,
    // ---------- interviews of the `/` commands ----------
    // the plan's round 5: an interview names its opening message and, once confirmed, its run. Sessions written before
    // have none
    `
    CREATE TABLE interviews (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        opening_id TEXT NOT NULL REFERENCES requests(id),
        run_id TEXT REFERENCES agent_runs(id),
        state TEXT NOT NULL,
        data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX interviews_by_session ON interviews(session_id, seq);
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
 * symbolic links. The database and its WAL files are 0600: an absent database is made empty (a valid one) 0600 before
 * SQLite opens it, since SQLite gives its WAL files the database's permissions; existing ones are tightened.
 */
export async function openSessionDatabase(root: string): Promise<DatabaseSync> {
    const dir = await sessionDirectory(root);
    const file = path.join(dir, DATABASE_FILE);
    const files = [file, `${file}-wal`, `${file}-shm`];
    for (const f of files) await checkPlain(f, 'file');
    await writeFile(file, '', { flag: 'wx', mode: PRIVATE_FILE }).catch((e: unknown) => {
        // there already (or made at the same time by another process): checked again below
        if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    });
    for (const f of files) if ((await checkPlain(f, 'file')) === 'present') await restrict(f, PRIVATE_FILE);
    const db = openDatabase(file);
    // the WAL files SQLite made, should the umask have loosened them: only looked at while the connection is open. Its
    // locks are the process's (POSIX), and closing any other handle on these files drops them all: another process
    // (`dt open link`) closing its connection would then take itself for the last one and remove the WAL files this one
    // still uses, which would no longer see what the others write, nor be seen. Loose ones are tightened with it closed.
    let loose = false;
    try {
        for (const f of files) if ((await checkPlain(f, 'file')) === 'present' && (await looserThan(f, PRIVATE_FILE))) loose = true;
    } catch (e) {
        db.close();
        throw e;
    }
    if (!loose) return db;
    db.close();
    for (const f of files) if ((await checkPlain(f, 'file')) === 'present') await restrict(f, PRIVATE_FILE);
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

/** An aggregate or event of our own rows: written by `encodeJson` from a value of that type (or its former shape, `upgrade`d). */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own rows, written from values of the type by the stores below
const decoded = <T>(json: string, upgrade: (v: unknown) => unknown = (v) => v): T => upgrade(decodeJson(json)) as T;

const params = (values: Record<string, SQLInputValue>): Record<string, SQLInputValue> => values;

// ---- Stores ----

function sessions(db: DatabaseSync): SessionRepository {
    const load = db.prepare('SELECT data FROM sessions WHERE id = :id');
    const save = db.prepare(
        'INSERT INTO sessions (id, state, data) VALUES (:id, :state, :data) ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data',
    );
    const open = db.prepare("SELECT data FROM sessions WHERE state = 'Open' ORDER BY rowid");
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Session>(text(r, 'data'), upgradeSession) : undefined;
        },
        save(session) {
            save.run(params({ id: session.id, state: session.state, data: encodeJson(session) }));
        },
        listOpen() {
            return open.all().map((r) => decoded<Collaboration.OpenSession>(text(r, 'data'), upgradeSession));
        },
    };
}

function requests(db: DatabaseSync): RequestRepository {
    const load = db.prepare('SELECT data FROM requests WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO requests (id, session_id, seq, state, data, reply_to, reply_to_request, reverts)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM requests), :state, :data, :replyTo, :replyToRequest, :reverts)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    );
    const list = db.prepare('SELECT data FROM requests WHERE session_id = :session ORDER BY seq');
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Request>(text(r, 'data'), upgradeRequest) : undefined;
        },
        save(request) {
            const to = request.replyTo;
            save.run(
                params({
                    id: request.id,
                    session: request.session,
                    state: request.state,
                    data: encodeJson(request),
                    replyTo: to?.kind === 'Run' ? to.run : null,
                    replyToRequest: to?.kind === 'Message' ? to.request : null,
                    reverts: request.reverts ?? null,
                }),
            );
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.Request>(text(r, 'data'), upgradeRequest));
        },
    };
}

function storedRun(r: Row): StoredRun {
    const token = optionalText(r, 'lease_token');
    const lease: Lease | undefined =
        token === undefined ? undefined : { owner: text(r, 'lease_owner'), token, expiresAt: new Date(integer(r, 'lease_expires_at')) };
    return { run: decoded<Collaboration.AgentRun>(text(r, 'data'), upgradeRun), lease, completedWith: optionalText(r, 'completed_with') };
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
            return list.all(params({ session })).map((r) => decoded<Collaboration.AgentRun>(text(r, 'data'), upgradeRun));
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

function marks(db: DatabaseSync): MarkRepository {
    const load = db.prepare('SELECT data FROM marks WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO marks (id, session_id, seq, participant, target_key, sign, state, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM marks), :participant, :key, :sign, :state, :data)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    );
    const placed = db.prepare("SELECT data FROM marks WHERE session_id = :session AND state = 'Placed' ORDER BY seq");
    const placedBy = db.prepare("SELECT data FROM marks WHERE session_id = :session AND participant = :participant AND state = 'Placed' ORDER BY seq");
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Mark>(text(r, 'data')) : undefined;
        },
        save(mark) {
            save.run(
                params({
                    id: mark.id,
                    session: mark.session,
                    participant: mark.participant,
                    key: markKey(mark.target),
                    sign: signKey(mark.sign),
                    state: mark.state,
                    data: encodeJson(mark),
                }),
            );
        },
        placedBySession(session) {
            return placed.all(params({ session })).map((r) => decoded<Collaboration.PlacedMark>(text(r, 'data')));
        },
        placedBy(session, participant) {
            return placedBy.all(params({ session, participant })).map((r) => decoded<Collaboration.PlacedMark>(text(r, 'data')));
        },
    };
}

function approvals(db: DatabaseSync): ApprovalRepository {
    const save = db.prepare(
        `INSERT INTO approvals (id, session_id, seq, run_id, assumption, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM approvals), :run, :assumption, :data)`,
    );
    const list = db.prepare('SELECT data FROM approvals WHERE session_id = :session ORDER BY seq');
    return {
        save(approval) {
            save.run(
                params({
                    id: approval.id,
                    session: approval.session,
                    run: approval.assumption.run,
                    assumption: approval.assumption.assumption,
                    data: encodeJson(approval),
                }),
            );
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.AssumptionApproval>(text(r, 'data')));
        },
    };
}

function triages(db: DatabaseSync): TriageRepository {
    const load = db.prepare('SELECT data FROM triages WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO triages (id, session_id, seq, request_id, state, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM triages), :request, :state, :data)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    );
    const ofRequest = db.prepare('SELECT data FROM triages WHERE request_id = :request');
    const list = db.prepare('SELECT data FROM triages WHERE session_id = :session ORDER BY seq');
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Triage>(text(r, 'data')) : undefined;
        },
        save(triage) {
            save.run(params({ id: triage.id, session: triage.session, request: triage.request, state: triage.state, data: encodeJson(triage) }));
        },
        ofRequest(request) {
            const r = ofRequest.get(params({ request }));
            return r ? decoded<Collaboration.Triage>(text(r, 'data')) : undefined;
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.Triage>(text(r, 'data')));
        },
    };
}

function proposals(db: DatabaseSync): ProposalRepository {
    const load = db.prepare('SELECT data FROM proposals WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO proposals (id, session_id, seq, triage_id, request_id, run_id, state, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM proposals), :triage, :request, :run, :state, :data)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, run_id = excluded.run_id, data = excluded.data`,
    );
    const list = db.prepare('SELECT data FROM proposals WHERE session_id = :session ORDER BY seq');
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.ChangeProposal>(text(r, 'data'), upgradeProposal) : undefined;
        },
        save(proposal) {
            save.run(
                params({
                    id: proposal.id,
                    session: proposal.session,
                    triage: proposal.triage,
                    request: proposal.request,
                    run: proposal.state === 'Approved' ? proposal.run : null,
                    state: proposal.state,
                    data: encodeJson(proposal),
                }),
            );
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.ChangeProposal>(text(r, 'data'), upgradeProposal));
        },
    };
}

function interviews(db: DatabaseSync): InterviewRepository {
    const load = db.prepare('SELECT data FROM interviews WHERE id = :id');
    const save = db.prepare(
        `INSERT INTO interviews (id, session_id, seq, opening_id, run_id, state, data)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM interviews), :opening, :run, :state, :data)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, run_id = excluded.run_id, data = excluded.data`,
    );
    const list = db.prepare('SELECT data FROM interviews WHERE session_id = :session ORDER BY seq');
    return {
        load(id) {
            const r = load.get(params({ id }));
            return r ? decoded<Collaboration.Interview>(text(r, 'data')) : undefined;
        },
        save(interview) {
            save.run(
                params({
                    id: interview.id,
                    session: interview.session,
                    opening: interview.opening,
                    run: interview.state === 'Confirmed' ? interview.run : null,
                    state: interview.state,
                    data: encodeJson(interview),
                }),
            );
        },
        listBySession(session) {
            return list.all(params({ session })).map((r) => decoded<Collaboration.Interview>(text(r, 'data')));
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
        event: decoded<Collaboration.PersistentEvent>(text(r, 'payload'), upgradeEvent),
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

const isMode = (v: string): v is IdentityMode => v === 'dev' || v === 'access';

function access(db: DatabaseSync): AccessStore {
    const addLink = db.prepare('INSERT INTO facilitator_links (code_hash, session_id, expires_at) VALUES (:hash, :session, :expires)');
    const useLink = db.prepare(
        'UPDATE facilitator_links SET used_at = :now WHERE code_hash = :hash AND used_at IS NULL AND expires_at > :now RETURNING session_id',
    );
    const revokeLinks = db.prepare('UPDATE facilitator_links SET used_at = :now WHERE session_id = :session AND used_at IS NULL');
    const facilitator = db.prepare('SELECT provider, subject FROM facilitators WHERE session_id = :session');
    const setFacilitator = db.prepare(
        `INSERT INTO facilitators (session_id, provider, subject, bound_at) VALUES (:session, :provider, :subject, :at)
         ON CONFLICT (session_id) DO UPDATE SET provider = excluded.provider, subject = excluded.subject, bound_at = excluded.bound_at`,
    );
    const addSignIn = db.prepare('INSERT INTO sign_ins (token_hash, session_id, identity, created_at) VALUES (:hash, :session, :identity, :at)');
    const signIn = db.prepare('SELECT session_id, identity FROM sign_ins WHERE token_hash = :hash AND revoked_at IS NULL');
    const revokeSignIn = db.prepare('UPDATE sign_ins SET revoked_at = :at WHERE token_hash = :hash AND revoked_at IS NULL');
    const revokeSignIns = db.prepare('UPDATE sign_ins SET revoked_at = :at WHERE session_id = :session AND revoked_at IS NULL RETURNING identity');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the session of a row, written from a SessionId
    const sessionOf = (r: Row): Collaboration.SessionId => text(r, 'session_id') as Collaboration.SessionId;
    return {
        addLink(codeHash, session, expiresAt) {
            addLink.run(params({ hash: codeHash, session, expires: expiresAt.getTime() }));
        },
        useLink(codeHash, now) {
            const r = useLink.get(params({ hash: codeHash, now: now.getTime() }));
            return r ? sessionOf(r) : undefined;
        },
        revokeLinks(session, now) {
            revokeLinks.run(params({ session, now: now.getTime() }));
        },
        facilitator(session) {
            const r = facilitator.get(params({ session }));
            if (!r) return undefined;
            const provider = text(r, 'provider');
            if (!isMode(provider)) throw new Error(`Unknown identity provider ${provider}`);
            return { provider, subject: text(r, 'subject') } satisfies IdentityKey;
        },
        setFacilitator(session, identity, at) {
            setFacilitator.run(params({ session, provider: identity.provider, subject: identity.subject, at: at.getTime() }));
        },
        addSignIn(tokenHash, { session, identity }, at) {
            addSignIn.run(params({ hash: tokenHash, session, identity: encodeJson(identity), at: at.getTime() }));
        },
        signIn(tokenHash) {
            const r = signIn.get(params({ hash: tokenHash }));
            return r ? { session: sessionOf(r), identity: decoded<Identity>(text(r, 'identity')) } : undefined;
        },
        revokeSignIn(tokenHash, at) {
            return revokeSignIn.run(params({ hash: tokenHash, at: at.getTime() })).changes === 1;
        },
        revokeSignIns(session, at) {
            return revokeSignIns.all(params({ session, at: at.getTime() })).map((r) => {
                const { provider, subject } = decoded<Identity>(text(r, 'identity'));
                return { provider, subject };
            });
        },
    };
}

const isRestoreResult = (v: string): v is RestoreResult => v === 'Restored' || v === 'Refused' || v === 'Failed';

function operations(db: DatabaseSync): OperationLog {
    const record = db.prepare(
        `INSERT INTO restore_operations (id, session_id, seq, at, participant, identity_provider, identity_subject, revision_id,
                                         manual_revision_id, pre_restore_id, restored_id, result, reason, detail)
         VALUES (:id, :session, (SELECT COALESCE(MAX(seq), 0) + 1 FROM restore_operations), :at, :participant, :provider, :subject,
                 :revision, :manual, :preRestore, :restored, :result, :reason, :detail)`,
    );
    const list = db.prepare('SELECT * FROM restore_operations WHERE session_id = :session ORDER BY seq');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the IDs of our own rows, written from values of these types
    const id = <T>(r: Row, column: string): T | undefined => optionalText(r, column) as T | undefined;
    return {
        recordRestore(op) {
            record.run(
                params({
                    id: op.id,
                    session: op.session,
                    at: op.at.getTime(),
                    participant: op.by,
                    provider: op.identity?.provider ?? null,
                    subject: op.identity?.subject ?? null,
                    revision: op.revision,
                    manual: op.manual ?? null,
                    preRestore: op.preRestore ?? null,
                    restored: op.restored ?? null,
                    result: op.result,
                    reason: op.reason ?? null,
                    detail: op.detail ?? null,
                }),
            );
        },
        restores(session) {
            return list.all(params({ session })).map((r): RestoreOperation => {
                const result = text(r, 'result');
                if (!isRestoreResult(result)) throw new Error(`Unknown restore result ${result}`);
                const provider = optionalText(r, 'identity_provider');
                if (provider !== undefined && !isMode(provider)) throw new Error(`Unknown identity provider ${provider}`);
                const manual = id<Collaboration.RevisionId>(r, 'manual_revision_id');
                const preRestore = id<Collaboration.RevisionId>(r, 'pre_restore_id');
                const restored = id<Collaboration.RevisionId>(r, 'restored_id');
                const reason = optionalText(r, 'reason');
                const detail = optionalText(r, 'detail');
                const revision = id<Collaboration.RevisionId>(r, 'revision_id');
                const by = id<Collaboration.ParticipantId>(r, 'participant');
                if (!revision || !by) throw new Error('A restore operation without its revision or participant');
                return {
                    id: text(r, 'id'),
                    session,
                    at: new Date(integer(r, 'at')),
                    by,
                    ...(provider !== undefined && { identity: { provider, subject: text(r, 'identity_subject') } }),
                    revision,
                    ...(manual && { manual }),
                    ...(preRestore && { preRestore }),
                    ...(restored && { restored }),
                    result,
                    ...(reason !== undefined && { reason }),
                    ...(detail !== undefined && { detail }),
                };
            });
        },
    };
}

/** The stores over one database connection; use them inside a transaction of `createUnitOfWork`. */
export function createStores(db: DatabaseSync): Stores {
    return {
        sessions: sessions(db),
        requests: requests(db),
        runs: runs(db),
        revisions: revisions(db),
        marks: marks(db),
        approvals: approvals(db),
        triages: triages(db),
        proposals: proposals(db),
        interviews: interviews(db),
        outbox: outbox(db),
        access: access(db),
        operations: operations(db),
    };
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
