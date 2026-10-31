// Drafts of requests (ADR 0026, Request): kept only in this browser's IndexedDB, per session and participant, and
// saved as they are typed. Nothing about a draft reaches the server until it is sent; each draft sent becomes its own
// request (immutable once sent: a correction is a new request), and only then is the draft removed.
import type { TargetDraft } from './targets';

export interface Draft {
    readonly id: string;
    readonly target: TargetDraft;
    readonly body: string;
    /** Milliseconds since the epoch. */
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** Whose drafts: the session and the participant, so that two participants in one browser never see each other's. */
export interface DraftScope {
    readonly session: string;
    readonly participant: string;
}

/** Where drafts are kept. */
export interface DraftStorage {
    /** The scope's drafts, oldest first. */
    load(scope: DraftScope): Promise<Draft[]>;
    /** Adds or replaces a draft. */
    save(scope: DraftScope, draft: Draft): Promise<void>;
    remove(scope: DraftScope, id: string): Promise<void>;
}

export const scopeKey = (scope: DraftScope): string => `${scope.session}\u0000${scope.participant}`;

export const newDraft = (id: string, target: TargetDraft, now: number): Draft => ({ id, target, body: '', createdAt: now, updatedAt: now });

/** The drafts with one changed (its text or its target), in the same order. */
export function editDraft(drafts: readonly Draft[], id: string, patch: Partial<Pick<Draft, 'body' | 'target'>>, now: number): Draft[] {
    return drafts.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: now } : d));
}

/** Oldest first, then by ID (a stable order for drafts made in the same millisecond). */
export const sortDrafts = (drafts: readonly Draft[]): Draft[] => [...drafts].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** The selected drafts that can be sent (with a text that is not blank), in the drafts' order. */
export function sendable(drafts: readonly Draft[], selected: ReadonlySet<string>): Draft[] {
    return drafts.filter((d) => selected.has(d.id) && d.body.trim() !== '');
}

/** Drafts in memory (tests, and a browser without IndexedDB: they then live as long as the page). */
export function createMemoryDrafts(): DraftStorage {
    const scopes = new Map<string, Map<string, Draft>>();
    const of = (scope: DraftScope): Map<string, Draft> => {
        const key = scopeKey(scope);
        let drafts = scopes.get(key);
        if (!drafts) scopes.set(key, (drafts = new Map()));
        return drafts;
    };
    return {
        load: async (scope) => sortDrafts([...of(scope).values()]),
        save: async (scope, draft) => void of(scope).set(draft.id, draft),
        remove: async (scope, id) => void of(scope).delete(id),
    };
}

const DB_NAME = 'domaintrail-session';
const STORE = 'drafts';

interface StoredDraft extends Draft {
    readonly scope: string;
}

const done = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });

const committed = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });

/** Drafts in IndexedDB: one object store keyed by `[scope, id]`, with an index on the scope. */
export function createIndexedDbDrafts(factory: IDBFactory): DraftStorage {
    let opened: Promise<IDBDatabase> | undefined;
    const db = (): Promise<IDBDatabase> => {
        opened ??= new Promise((resolve, reject) => {
            const request = factory.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore(STORE, { keyPath: ['scope', 'id'] });
                store.createIndex('scope', 'scope');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
        });
        return opened;
    };
    return {
        async load(scope) {
            const tx = (await db()).transaction(STORE, 'readonly');
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store holds only what `save` wrote
            const rows = (await done(tx.objectStore(STORE).index('scope').getAll(scopeKey(scope)))) as StoredDraft[];
            return sortDrafts(rows.map(({ scope: _, ...draft }) => draft));
        },
        async save(scope, draft) {
            const tx = (await db()).transaction(STORE, 'readwrite');
            const row: StoredDraft = { ...draft, scope: scopeKey(scope) };
            tx.objectStore(STORE).put(row);
            await committed(tx);
        },
        async remove(scope, id) {
            const tx = (await db()).transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete([scopeKey(scope), id]);
            await committed(tx);
        },
    };
}
