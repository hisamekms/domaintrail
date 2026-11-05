// The read-only knowledge tools of `dt mcp` (ADR 0031, section 9), over the `KnowledgeStore` port: what Claude Code
// reads before it implements an element of the model, searches, or opens one item by ID. Each returns short text
// (Markdown) for a model to read; a wrong input or an unavailable store is an error of the tool.
//
// Only dt can turn a `.dt` element into the stickies of the stormings that `ref` it, so the tools read the workspace's
// `.dtes` on every call (`stickies`): the stormings may have changed since the server started.
import { Knowledge, type KnowledgeStore } from '@domaintrail/knowledge';
import { declarations, type NodeElementKind, type Storming } from '@domaintrail/storming';
import type { McpTool, McpToolResult } from './protocol.js';

/** A sticky of the workspace's stormings, as the tools show it. */
export interface StickyInfo {
    /** `<Storming>.<LocalId>`. */
    readonly ref: Knowledge.StickyRef;
    readonly kind: NodeElementKind;
    readonly label?: string;
    /** Its `ref` to the `.dt` model (`Sales.Order.confirm`), if it has one. */
    readonly dt?: string;
}

/** The stickies of the workspace's stormings, by `<Storming>.<LocalId>`. */
export type StickyIndex = ReadonlyMap<string, StickyInfo>;

/** The stickies of `stormings` (the node elements: not the timelines, groups and stages). */
export function stickyIndex(stormings: readonly Storming[]): StickyIndex {
    const index = new Map<string, StickyInfo>();
    for (const s of stormings)
        for (const d of declarations(s)) {
            if (d.kind === 'timeline' || d.kind === 'group' || d.kind === 'stage') continue;
            const dt = d.clauses.find((c) => c.type === 'ref');
            const ref = Knowledge.makeStickyRef(`${s.id}.${d.id}`);
            if (!ref.ok) continue; // an ID the syntax let through but no sticky reference can name: nothing is about it
            index.set(ref.value, {
                ref: ref.value,
                kind: d.kind,
                ...(d.label !== undefined && { label: d.label }),
                ...(dt?.type === 'ref' && { dt: dt.path }),
            });
        }
    return index;
}

/** The store the tools read, or why there is none (said by every tool). */
export type KnowledgeAccess = { readonly store: KnowledgeStore; readonly project: Knowledge.ProjectName } | { readonly unavailable: string };

export interface KnowledgeToolsOptions {
    readonly access: KnowledgeAccess;
    /** The stickies of the workspace's stormings now. */
    readonly stickies: () => Promise<StickyIndex>;
}

// ---- the labels -------------------------------------------------------------------------------------------------

const WHEN: Readonly<Record<Knowledge.When, string>> = { as_is: 'AS-IS', to_be: 'TO-BE', none: 'なし' };
const KIND: Readonly<Record<Knowledge.KnowledgeKind, string>> = {
    rule: 'ルール',
    flow: '流れ',
    example: '例',
    term: '言葉',
    pain: '困りごと',
    want: '要望',
    decision: '決定',
};
const ORIGIN: Readonly<Record<Knowledge.Origin, string>> = { said: '発言', agreed: '合意', investigated: '調査', inferred: '推測' };

const WHENS: readonly Knowledge.When[] = ['as_is', 'to_be', 'none'];
const KINDS: readonly Knowledge.KnowledgeKind[] = ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'];
const ORIGINS: readonly Knowledge.Origin[] = ['said', 'agreed', 'investigated', 'inferred'];

/** How many items a search returns by default, and at most. */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
/** How much of an item's text a list shows (`knowledge_get` shows all of it). */
export const LIST_TEXT_CHARS = 600;

// ---- the text ---------------------------------------------------------------------------------------------------

const day = (d: Date): string => d.toISOString().slice(0, 10);
const minute = (d: Date): string => `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;

function stickyText(ref: string, stickies: StickyIndex): string {
    const s = stickies.get(ref);
    if (!s) return `${ref} (no such sticky in the stormings now)`;
    return `${ref}${s.label !== undefined ? ` "${s.label}"` : ''} (${s.kind}${s.dt !== undefined ? `, dt:${s.dt}` : ''})`;
}

function labelsLine(labels: Knowledge.Labels): string {
    return [labels.kind, labels.when === 'none' ? undefined : labels.when, labels.origin, labels.perspective].filter((l) => l !== undefined).join(' · ');
}

function dates(item: Knowledge.LiveKnowledgeItem): string {
    const made = day(item.createdAt);
    const changed = day(item.updatedAt);
    return `${made}${changed !== made ? `, updated ${changed}` : ''}${item.version > 1 ? `, v${item.version}` : ''}`;
}

function shortText(text: string): string {
    const t = text.trim();
    return t.length <= LIST_TEXT_CHARS ? t : `${t.slice(0, LIST_TEXT_CHARS).trimEnd()}… (cut; knowledge_get has all of it)`;
}

/** An item in a list: its ID and title, labels and date, the stickies it is about, its conflicts, and its text (cut). */
export function itemSummary(item: Knowledge.LiveKnowledgeItem, stickies: StickyIndex): string {
    return [
        `## ${item.id} — ${item.content.title}`,
        `${labelsLine(item.content.labels)} (${dates(item)})`,
        ...(item.content.about.length ? [`about: ${item.content.about.map((a) => stickyText(a, stickies)).join(', ')}`] : []),
        ...(item.conflictsWith.length ? [`conflicts with: ${item.conflictsWith.join(', ')} (contradicts it; read both)`] : []),
        '',
        shortText(item.content.text),
    ].join('\n');
}

const legend =
    "Labels: kind, when (as_is / to_be), origin (said: one person, unconfirmed; agreed: several agreed; investigated: the AI checked code or documents; inferred: the AI's guess), perspective.";

function itemList(items: readonly Knowledge.LiveKnowledgeItem[], stickies: StickyIndex): string {
    return [legend, ...items.map((i) => itemSummary(i, stickies))].join('\n\n');
}

// ---- the inputs -------------------------------------------------------------------------------------------------

class BadInput extends Error {}

const DT_PREFIX = 'dt:';

function text(args: Readonly<Record<string, unknown>>, name: string, required: true): string;
function text(args: Readonly<Record<string, unknown>>, name: string, required?: false): string | undefined;
function text(args: Readonly<Record<string, unknown>>, name: string, required = false): string | undefined {
    const v = args[name];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && !required)) {
        if (required) throw new BadInput(`'${name}' is required.`);
        return undefined;
    }
    if (typeof v !== 'string' || v.trim() === '') throw new BadInput(`'${name}' must be a non-empty string.`);
    return v.trim();
}

/** A filter given as one value or a list of them, each one of `allowed`. */
function values<T extends string>(args: Readonly<Record<string, unknown>>, name: string, allowed: readonly T[]): T[] | undefined {
    const v = args[name];
    if (v === undefined || v === null) return undefined;
    const list: unknown[] = Array.isArray(v) ? v : [v];
    const isAllowed = (x: unknown): x is T => allowed.some((a) => a === x);
    const wrong = list.filter((x) => !isAllowed(x));
    if (wrong.length) throw new BadInput(`'${name}' must be one or more of ${allowed.join(', ')}; got ${wrong.map((w) => JSON.stringify(w)).join(', ')}.`);
    const given = list.filter(isAllowed);
    return given.length ? given : undefined;
}

function strings(args: Readonly<Record<string, unknown>>, name: string): string[] | undefined {
    const v = args[name];
    if (v === undefined || v === null) return undefined;
    const list: unknown[] = Array.isArray(v) ? v : [v];
    const given = list.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (given.length !== list.length) throw new BadInput(`'${name}' must be a string or a list of strings.`);
    return given.length ? given.map((x) => x.trim()) : undefined;
}

/** What an element names: the stickies to look up, and how they were found. */
interface Resolved {
    readonly stickies: readonly Knowledge.StickyRef[];
    /** Said above the items: what the element resolved to, or why nothing. */
    readonly note: string;
}

const STICKY_FORMAT =
    "a sticky as '<Storming>.<LocalId>' (e.g. 'Ordering.CreateSpecification'), or a .dt element as 'dt:<Context>.<Aggregate>[.<command>]' or 'dt:<Context>.<Event>'";

/**
 * A sticky (`Ordering.CreateSpecification`), or a `.dt` element (`dt:Sales.Order.confirm`) resolved through the
 * stickies whose `ref` is that element or an element inside it (`dt:Sales.Order` takes the stickies of its commands).
 */
function resolveElement(element: string, stickies: StickyIndex): Resolved {
    if (element.startsWith(DT_PREFIX)) {
        const target = element.slice(DT_PREFIX.length).trim();
        if (!/^[_a-zA-Z][_a-zA-Z0-9]*(\.[_a-zA-Z][_a-zA-Z0-9]*)*$/.test(target)) throw new BadInput(`'${element}' is not ${STICKY_FORMAT}.`);
        const found = [...stickies.values()].filter((s) => s.dt === target || s.dt?.startsWith(`${target}.`));
        return {
            stickies: found.map((s) => s.ref),
            note: found.length
                ? `${element} is drawn as: ${found.map((s) => stickyText(s.ref, stickies)).join(', ')}.`
                : `No sticky of the workspace's stormings has \`ref ${target}\` (or a ref inside it), so no knowledge is attached to ${element}. Knowledge is about stickies: find the sticky of the flow with knowledge_search, or look for a differently named element.`,
        };
    }
    const made = Knowledge.makeStickyRef(element);
    if (!made.ok) throw new BadInput(`'${element}' is not ${STICKY_FORMAT}.`);
    const sticky = stickies.get(element);
    if (sticky) return { stickies: [made.value], note: `${stickyText(element, stickies)}.` };
    // not a sticky: perhaps a `.dt` element written without `dt:`
    const asDt = [...stickies.values()].filter((s) => s.dt === element || s.dt?.startsWith(`${element}.`));
    return {
        stickies: [made.value],
        note: `${element} is no sticky of the workspace's stormings now (items about it may remain).${asDt.length ? ` Did you mean dt:${element}? Stickies ref it: ${asDt.map((s) => s.ref).join(', ')}.` : ''}`,
    };
}

function itemId(args: Readonly<Record<string, unknown>>): Knowledge.KnowledgeItemId {
    const id = text(args, 'id', true);
    const made = Knowledge.makeKnowledgeItemId(id);
    if (!made.ok) throw new BadInput(`'${id}' is not a knowledge item ID ('kn_' and 8 to 32 lowercase letters or digits).`);
    return made.value;
}

function limitOf(args: Readonly<Record<string, unknown>>): number {
    const v = args.limit;
    if (v === undefined || v === null) return DEFAULT_SEARCH_LIMIT;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new BadInput(`'limit' must be a whole number from 1 to ${MAX_SEARCH_LIMIT}.`);
    return Math.min(v, MAX_SEARCH_LIMIT);
}

// ---- the tools --------------------------------------------------------------------------------------------------

const enumSchema = (allowed: readonly string[], description: string): Record<string, unknown> => ({
    description: `${description} One value or a list (any of them).`,
    anyOf: [
        { type: 'string', enum: allowed },
        { type: 'array', items: { type: 'string', enum: allowed } },
    ],
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The three tools, reading `options.access`'s store and the workspace's stickies. */
export function knowledgeTools(options: KnowledgeToolsOptions): McpTool[] {
    /** Runs `f` with the store; a bad input or a missing store is an error of the tool. */
    const withStore =
        (f: (store: KnowledgeStore, project: Knowledge.ProjectName, args: Readonly<Record<string, unknown>>) => Promise<McpToolResult>) =>
        async (args: Readonly<Record<string, unknown>>): Promise<McpToolResult> => {
            const { access } = options;
            if ('unavailable' in access) return { text: `No knowledge can be read: ${access.unavailable}.`, isError: true };
            try {
                return await f(access.store, access.project, args);
            } catch (e) {
                if (e instanceof BadInput) return { text: e.message, isError: true };
                throw e;
            }
        };

    return [
        {
            name: 'knowledge_for_element',
            title: 'Knowledge about an element',
            description:
                "Call this before implementing or changing an element of the domain model: it returns what the project learned about it in its modeling sessions — why it is so, rules, examples, terms, pains, wants and decisions, each with its ID, title, labels and date. `element` is a sticky of an Event Storming ('<Storming>.<LocalId>', e.g. 'Ordering.CreateSpecification') or a .dt element ('dt:<Context>.<Aggregate>.<command>', 'dt:<Context>.<Aggregate>', 'dt:<Context>.<Event>'), resolved through the stickies whose `ref` points to it. Newest first; open one with knowledge_get for its sources and the whole text.",
            inputSchema: {
                type: 'object',
                properties: {
                    element: {
                        type: 'string',
                        description: "A sticky 'Storming.LocalId', or a .dt element prefixed with 'dt:' (e.g. 'dt:Sales.Order.confirm').",
                    },
                },
                required: ['element'],
                additionalProperties: false,
            },
            annotations: { title: 'Knowledge about an element', ...READ_ONLY },
            call: withStore(async (store, project, args) => {
                const element = text(args, 'element', true);
                const stickies = await options.stickies();
                const resolved = resolveElement(element, stickies);
                if (resolved.stickies.length === 0) return { text: resolved.note };
                const items = await store.about(project, resolved.stickies);
                if (items.length === 0) return { text: `${resolved.note}\nNo knowledge about it yet.` };
                return { text: `${resolved.note}\n${items.length} item(s), newest first.\n\n${itemList(items, stickies)}` };
            }),
        },
        {
            name: 'knowledge_search',
            title: 'Search the knowledge',
            description:
                "Searches the project's knowledge (what was said and found in its modeling sessions). Every given filter must hold; none lists the newest items. `query` is full text (every word must appear, in the title, the text or the quotes); `about` stickies ('Storming.LocalId') or .dt elements ('dt:Sales.Order.confirm'); `when`, `kind`, `origin` one value or a list; `perspective` a role (案件担当, 営業, …). Newest first.",
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Full text: every word must appear in the title, the text or a quote.' },
                    about: {
                        description: "Items about any of these: stickies 'Storming.LocalId', or .dt elements 'dt:Context.Aggregate.command'.",
                        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    },
                    when: enumSchema(WHENS, 'as_is (how it is done today), to_be (how it should be), none.'),
                    kind: enumSchema(KINDS, 'rule, flow, example, term, pain, want, decision.'),
                    origin: enumSchema(
                        ORIGINS,
                        "said (one person, unconfirmed), agreed (several people agreed), investigated (the AI checked code or documents), inferred (the AI's guess).",
                    ),
                    perspective: { type: 'string', description: 'A role, e.g. 案件担当, 営業, 外注先 (exactly as labelled).' },
                    limit: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_SEARCH_LIMIT,
                        description: `At most this many items (default ${DEFAULT_SEARCH_LIMIT}).`,
                    },
                },
                additionalProperties: false,
            },
            annotations: { title: 'Search the knowledge', ...READ_ONLY },
            call: withStore(async (store, project, args) => {
                const query = text(args, 'query');
                const aboutGiven = strings(args, 'about');
                const when = values(args, 'when', WHENS);
                const kind = values(args, 'kind', KINDS);
                const origin = values(args, 'origin', ORIGINS);
                const perspectiveText = text(args, 'perspective');
                const limit = limitOf(args);
                let perspective: Knowledge.Perspective | undefined;
                if (perspectiveText !== undefined) {
                    const made = Knowledge.makePerspective(perspectiveText);
                    if (!made.ok) throw new BadInput("'perspective' must be a role of 1 to 100 characters.");
                    perspective = made.value;
                }
                const stickies = await options.stickies();
                const notes: string[] = [];
                let about: Knowledge.StickyRef[] | undefined;
                if (aboutGiven) {
                    const resolved = aboutGiven.map((a) => resolveElement(a, stickies));
                    about = [...new Set(resolved.flatMap((r) => r.stickies))];
                    notes.push(...resolved.map((r) => r.note));
                    if (about.length === 0) return { text: `${notes.join('\n')}\nNo item can match.` };
                }
                const page = await store.search(project, {
                    ...(query !== undefined && { q: query }),
                    ...(about && { about }),
                    ...(when && { when }),
                    ...(kind && { kind }),
                    ...(origin && { origin }),
                    ...(perspective !== undefined && { perspective }),
                    limit,
                });
                const head = [
                    ...notes,
                    page.items.length === 0
                        ? 'No item matches.'
                        : `${page.items.length} item(s), newest first${page.next !== undefined ? `; more match: narrow the search or raise limit (at most ${MAX_SEARCH_LIMIT})` : ''}.`,
                ].join('\n');
                return { text: page.items.length === 0 ? head : `${head}\n\n${itemList(page.items, stickies)}` };
            }),
        },
        {
            name: 'knowledge_get',
            title: 'One knowledge item',
            description:
                "One knowledge item by its ID ('kn_…'): its title and whole text, labels, the stickies it is about, the items it conflicts with, and its sources (session, message, time and a short quote of what was said). With `history`, also its earlier versions.",
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: "The item's ID, 'kn_…'." },
                    history: { type: 'boolean', description: 'Also its earlier versions (default false).' },
                },
                required: ['id'],
                additionalProperties: false,
            },
            annotations: { title: 'One knowledge item', ...READ_ONLY },
            call: withStore(async (store, project, args) => {
                const id = itemId(args);
                const history = args.history;
                if (history !== undefined && typeof history !== 'boolean') throw new BadInput("'history' must be true or false.");
                const found = await store.get(project, id, { history: history === true });
                if (!found) return { text: `No knowledge item ${id}: the ID is wrong, or the item was deleted.`, isError: true };
                const stickies = await options.stickies();
                const conflicts = await Promise.all(found.item.conflictsWith.map(async (other) => ({ other, item: (await store.get(project, other))?.item })));
                return { text: itemDetail(found.item, stickies, conflicts, history === true ? found.history : undefined) };
            }),
        },
    ];
}

/** An item whole (`knowledge_get`). */
export function itemDetail(
    item: Knowledge.LiveKnowledgeItem,
    stickies: StickyIndex,
    conflicts: readonly { readonly other: Knowledge.KnowledgeItemId; readonly item?: Knowledge.LiveKnowledgeItem }[],
    history?: readonly { readonly version: Knowledge.ItemVersion; readonly content: Knowledge.ItemContent; readonly replacedAt: Date }[],
): string {
    const { labels } = item.content;
    const out = [
        `## ${item.id} — ${item.content.title}`,
        `kind: ${labels.kind} (${KIND[labels.kind]}) · when: ${labels.when} (${WHEN[labels.when]}) · origin: ${labels.origin} (${ORIGIN[labels.origin]})${labels.perspective !== undefined ? ` · perspective: ${labels.perspective}` : ''}`,
        `version ${item.version} · created ${minute(item.createdAt)}${item.createdIn !== undefined ? ` in session ${item.createdIn}` : ''} · updated ${minute(item.updatedAt)}`,
        `about: ${item.content.about.length ? item.content.about.map((a) => stickyText(a, stickies)).join(', ') : '(no sticky)'}`,
        ...conflicts.map(({ other, item: o }) => `conflicts with ${other}: ${o ? o.content.title : '(deleted)'}`),
        '',
        item.content.text.trim(),
        '',
        '### Sources',
        ...(item.sources.length
            ? item.sources.map((s) => `- ${minute(s.at)}, session ${s.session}, message ${s.message}: "${s.quote}"`)
            : ['- (none: written by hand)']),
    ];
    if (history !== undefined) {
        out.push('', '### Earlier versions');
        if (history.length === 0)
            out.push(
                item.version > 1
                    ? `- (not kept by this store; with the files store, \`git log -p knowledge/${item.id}.md\` has them)`
                    : '- (none: this is the first version)',
            );
        for (const h of history)
            out.push(
                `- v${h.version} (replaced ${minute(h.replacedAt)}): ${h.content.title} — ${labelsLine(h.content.labels)}; about ${h.content.about.join(', ') || '(no sticky)'}`,
            );
    }
    return out.join('\n');
}
