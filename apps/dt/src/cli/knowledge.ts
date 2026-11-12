import { Command, Option } from 'commander';
import { userInfo } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Knowledge, type KnowledgeQuery } from '@domaintrail/knowledge';
import type { ItemWithHistory } from '@domaintrail/knowledge';
import type { ResolvedConfig } from '../config/config.js';
import type { CliDeps, CliKnowledgeAccess } from './ports.js';
import type { CliIO } from './main.js';
import { checkApproved } from './trust.js';

interface Context {
    config: () => Promise<ResolvedConfig>;
    deps: CliDeps;
    io: CliIO;
    setExitCode: (code: number) => void;
}

class KnowledgeInputError extends Error {}

function itemId(value: string): Knowledge.KnowledgeItemId {
    const made = Knowledge.makeKnowledgeItemId(value);
    if (!made.ok) throw new KnowledgeInputError(`Invalid knowledge item ID: ${value}.`);
    return made.value;
}

function proposalId(value: string): Knowledge.RetirementProposalId {
    const made = Knowledge.makeRetirementProposalId(value);
    if (!made.ok) throw new KnowledgeInputError(`Invalid proposal ID: ${value}.`);
    return made.value;
}

function actor(config: ResolvedConfig, supplied?: string): Knowledge.UserName {
    if (config.knowledge.store === 'cloudflare' && !supplied) throw new KnowledgeInputError('--actor is required for Cloudflare writes.');
    const name = supplied ?? userInfo().username;
    if (!name.trim()) throw new KnowledgeInputError('--actor must not be empty.');
    // CLI actors are self-asserted, including on Cloudflare; this is never a verified Access identity.
    const made = Knowledge.makeUserName(`cli:${name}`);
    if (!made.ok) throw new KnowledgeInputError('--actor is too long.');
    return made.value;
}

function result<T, E extends { readonly type: string }>(answer: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }): T {
    if (answer.ok) return answer.value;
    const error = answer.error;
    if (error.type === 'Knowledge.KnowledgeItemVersionConflict' && 'currentVersion' in error && 'expectedVersion' in error)
        throw new KnowledgeInputError(
            `Knowledge item changed while editing (opened version ${String(error.expectedVersion)}, now version ${String(error.currentVersion)}). Reopen the editor and try again.`,
        );
    switch (error.type) {
        case 'Knowledge.KnowledgeItemNotFound':
            throw new KnowledgeInputError(`Knowledge item ${'itemId' in error ? String(error.itemId) : ''} was not found.`);
        case 'Knowledge.KnowledgeItemGone':
            throw new KnowledgeInputError(`Knowledge item ${'itemId' in error ? String(error.itemId) : ''} was deleted.`);
        case 'Knowledge.AlreadyRetired':
            throw new KnowledgeInputError('Knowledge item is already retired.');
        case 'Knowledge.NotRetired':
            throw new KnowledgeInputError('Knowledge item is not retired.');
        case 'Knowledge.ReplacedByItself':
            throw new KnowledgeInputError('A knowledge item cannot replace itself.');
        case 'Knowledge.ReplacementWithoutReason':
            throw new KnowledgeInputError('A replacement requires reason replaced.');
        case 'Knowledge.ProposalNotFound':
            throw new KnowledgeInputError(`Proposal ${'proposalId' in error ? String(error.proposalId) : ''} was not found.`);
        case 'Knowledge.ProposalDecided':
            throw new KnowledgeInputError(`Proposal ${'proposalId' in error ? String(error.proposalId) : ''} was already decided.`);
        case 'Knowledge.ProposalRefused':
            throw new KnowledgeInputError(`Proposal refused: ${'reason' in error ? String(error.reason) : 'unknown reason'}.`);
    }
    throw new KnowledgeInputError(`Knowledge write refused: ${error.type}${'reason' in error ? ` (${String(error.reason)})` : ''}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function choice<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    const found = allowed.find((entry) => entry === value);
    if (found === undefined) throw new KnowledgeInputError(`Invalid ${field}.`);
    return found;
}

function editedContent(value: unknown, id: Knowledge.KnowledgeItemId, version: number): Knowledge.ItemContent {
    if (!isRecord(value)) throw new KnowledgeInputError('Editor file must contain a JSON object.');
    const document = value;
    if (document.id !== id || document.version !== version) throw new KnowledgeInputError('Editor file ID and version must stay unchanged.');
    if (typeof document.title !== 'string') throw new KnowledgeInputError('Title must be text.');
    if (typeof document.text !== 'string') throw new KnowledgeInputError('Text must be text.');
    const title = Knowledge.makeItemTitle(document.title);
    const text = Knowledge.makeItemText(document.text);
    if (!title.ok) throw new KnowledgeInputError('Title must be nonempty, one line, at most 40 characters, without surrounding whitespace.');
    if (!text.ok) throw new KnowledgeInputError('Text must contain 1–20,000 characters.');
    if (!isRecord(document.labels)) throw new KnowledgeInputError('Labels must be an object.');
    const labels = document.labels;
    const when = choice(labels.when, ['as_is', 'to_be', 'none'] as const, 'labels.when');
    const kind = choice(labels.kind, ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'] as const, 'labels.kind');
    const origin = choice(labels.origin, ['said', 'agreed', 'investigated', 'inferred'] as const, 'labels.origin');
    const perspective =
        labels.perspective === undefined ? undefined : typeof labels.perspective === 'string' ? Knowledge.makePerspective(labels.perspective) : undefined;
    if (labels.perspective !== undefined && (!perspective || !perspective.ok)) throw new KnowledgeInputError('Invalid labels.perspective.');
    if (!Array.isArray(document.about)) throw new KnowledgeInputError('About must be a list of sticky references.');
    const about = document.about.map((entry: unknown) => {
        if (typeof entry !== 'string') throw new KnowledgeInputError('About entries must be sticky references.');
        const made = Knowledge.makeStickyRef(entry);
        if (!made.ok) throw new KnowledgeInputError(`Invalid sticky reference: ${entry}.`);
        return made.value;
    });
    if (new Set(about).size !== about.length) throw new KnowledgeInputError('About entries must be distinct.');
    return {
        title: title.value,
        text: text.value,
        labels: {
            when,
            kind,
            origin,
            ...(perspective?.ok && { perspective: perspective.value }),
        },
        about,
    };
}

async function openEditor(document: object, editor: string, env?: Readonly<Record<string, string | undefined>>): Promise<unknown> {
    const parts = editor.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new KnowledgeInputError('Set VISUAL or EDITOR to edit a knowledge item.');
    const directory = await mkdtemp(join(tmpdir(), 'dt-knowledge-edit-'));
    const file = join(directory, 'item.json');
    try {
        await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        const exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(parts[0]!, [...parts.slice(1), file], { stdio: 'inherit', env: { ...process.env, ...env }, shell: false });
            child.once('error', reject);
            child.once('exit', (code) => resolve(code ?? 1));
        });
        if (exitCode !== 0) throw new KnowledgeInputError('Editor exited without saving the item.');
        try {
            return JSON.parse(await readFile(file, 'utf8')) as unknown;
        } catch {
            throw new KnowledgeInputError('Editor file must contain valid JSON.');
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const positiveLimit = (text: string): number => {
    if (!/^[1-9][0-9]*$/.test(text) || Number(text) > 100 || !Number.isSafeInteger(Number(text)))
        throw new KnowledgeInputError('--limit must be a whole number from 1 to 100.');
    return Number(text);
};

function contentLines(content: Knowledge.ItemContent): string[] {
    return [
        `Title: ${content.title}`,
        `When: ${content.labels.when} · Kind: ${content.labels.kind} · Origin: ${content.labels.origin}${content.labels.perspective ? ` · Perspective: ${content.labels.perspective}` : ''}`,
        `About: ${content.about.join(', ') || 'none'}`,
        '',
        content.text,
    ];
}

function showText({ item, history }: ItemWithHistory, withHistory: boolean): string {
    return [
        `${item.id}${item.retirement ? ' [retired]' : ''}`,
        `Version ${item.version} · created ${item.createdAt.toISOString()} · updated ${item.updatedAt.toISOString()}`,
        ...contentLines(item.content),
        '',
        `Conflicts with: ${item.conflictsWith.join(', ') || 'none'}`,
        `Bookmarked: ${item.bookmarked === true ? 'yes' : 'no'}`,
        ...(item.createdIn ? [`Created in session: ${item.createdIn}`] : []),
        ...(item.retirement
            ? [
                  `Retired: ${item.retirement.reason ?? 'no reason'}${item.retirement.replacedBy ? `; replaced by ${item.retirement.replacedBy}` : ''}; by ${item.retirement.by} at ${item.retirement.at.toISOString()}`,
              ]
            : []),
        '',
        `Sources: ${item.sources.length}`,
        ...item.sources.flatMap((source) => [`  ${source.session}/${source.message} · ${source.at.toISOString()}`, `    ${source.quote}`]),
        ...(withHistory
            ? [
                  '',
                  `History: ${history?.length ?? 0} previous version(s)`,
                  ...(history ?? []).flatMap((past) => ['', `v${past.version} · replaced ${past.replacedAt.toISOString()}`, ...contentLines(past.content)]),
              ]
            : []),
    ].join('\n');
}

/** Shared command runner: validation, approved store access, and one output/error policy. */
export async function withKnowledgeStore<Input, Output>(
    context: Context,
    json: boolean,
    validate: () => Input,
    action: (access: CliKnowledgeAccess, input: Input, config: ResolvedConfig) => Promise<Output>,
    render: (value: Output) => string,
): Promise<void> {
    try {
        const input = validate();
        const cfg = await context.config();
        const approval = await checkApproved(cfg, context.deps.trust);
        if (!context.deps.openKnowledgeStore) throw new Error('Knowledge store access is unavailable.');
        const opened = await context.deps.openKnowledgeStore(cfg, approval);
        if (!opened.ok) throw new Error(opened.error.message);
        const value = await action(opened.value, input, cfg);
        context.io.out(json ? JSON.stringify(value, null, 2) : render(value));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) context.io.out(JSON.stringify({ error: message }, null, 2));
        else context.io.err(message);
        context.setExitCode(
            error instanceof KnowledgeInputError ? 1 : typeof error === 'object' && error !== null && 'name' in error && error.name === 'ConfigError' ? 2 : 1,
        );
    }
}

/** Registers the knowledge CLI. */
export function registerKnowledgeCommand(program: Command, context: Context): void {
    const knowledge = program.command('knowledge').description('Read and manage knowledge items in the configured store.');
    knowledge
        .command('list')
        .description('List knowledge items, newest first.')
        .option('-q, --query <text>', 'search item text')
        .option('--about <sticky>', 'items about a sticky (Storming.LocalId)', (value: string, previous: string[]) => [...previous, value], [] as string[])
        .option('--when <value>', 'filter by when (repeatable)', (value: string, previous: string[]) => [...previous, value], [] as string[])
        .option('--kind <value>', 'filter by kind (repeatable)', (value: string, previous: string[]) => [...previous, value], [] as string[])
        .option('--origin <value>', 'filter by origin (repeatable)', (value: string, previous: string[]) => [...previous, value], [] as string[])
        .option('--perspective <value>', 'filter by perspective')
        .option('--session <id>', 'filter by originating session')
        .option('--bookmarked', 'only bookmarked items')
        .addOption(new Option('--retired <filter>', 'retired items').choices(['exclude', 'include', 'only']).default('exclude'))
        .option('--limit <number>', 'maximum items per page (1–100)', '20')
        .option('--cursor <cursor>', 'cursor returned by the previous page')
        .option('--json', 'print one JSON document')
        .action(
            async (options: {
                query?: string;
                about: string[];
                when: string[];
                kind: string[];
                origin: string[];
                perspective?: string;
                session?: string;
                bookmarked?: boolean;
                retired: 'exclude' | 'include' | 'only';
                limit: string;
                cursor?: string;
                json?: boolean;
            }) => {
                await withKnowledgeStore(
                    context,
                    options.json === true,
                    () => {
                        const limit = positiveLimit(options.limit);
                        if (options.query !== undefined && options.query.trim() === '') throw new KnowledgeInputError('--query must not be empty.');
                        if (options.cursor !== undefined && options.cursor.trim() === '') throw new KnowledgeInputError('--cursor must not be empty.');
                        const about = options.about.map((value) => {
                            const made = Knowledge.makeStickyRef(value);
                            if (!made.ok) throw new KnowledgeInputError(`Invalid sticky reference: ${value}. Expected Storming.LocalId.`);
                            return made.value;
                        });
                        const choices = <T extends string>(values: string[], allowed: readonly T[], name: string): T[] =>
                            values.map((value) => {
                                const found = allowed.find((choice) => choice === value);
                                if (found === undefined) throw new KnowledgeInputError(`Invalid --${name}: ${value}. Choose ${allowed.join(', ')}.`);
                                return found;
                            });
                        const perspective = options.perspective === undefined ? undefined : Knowledge.makePerspective(options.perspective);
                        if (perspective && !perspective.ok) throw new KnowledgeInputError(`Invalid --perspective: ${options.perspective}.`);
                        const session = options.session === undefined ? undefined : Knowledge.makeSessionRef(options.session);
                        if (session && !session.ok) throw new KnowledgeInputError(`Invalid --session: ${options.session}.`);
                        const query: KnowledgeQuery = {
                            limit,
                            ...(options.query !== undefined && { q: options.query }),
                            ...(about.length > 0 && { about }),
                            ...(options.when.length > 0 && { when: choices(options.when, ['as_is', 'to_be', 'none'], 'when') }),
                            ...(options.kind.length > 0 && {
                                kind: choices(options.kind, ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'], 'kind'),
                            }),
                            ...(options.origin.length > 0 && { origin: choices(options.origin, ['said', 'agreed', 'investigated', 'inferred'], 'origin') }),
                            ...(perspective?.ok && { perspective: perspective.value }),
                            ...(session?.ok && { session: session.value }),
                            ...(options.bookmarked && { bookmarked: true }),
                            ...(options.retired !== 'exclude' && { retired: options.retired }),
                            ...(options.cursor !== undefined && { cursor: options.cursor }),
                        };
                        return query;
                    },
                    ({ store, project }, query) => store.search(project, query),
                    (page) =>
                        [
                            ...page.items.map(
                                (item) => `${item.id}\t${item.content.title}${item.retirement ? ' [retired]' : ''}\t${item.updatedAt.toISOString()}`,
                            ),
                            ...(page.items.length === 0 ? ['No knowledge items found.'] : []),
                            ...(page.next ? [`Next cursor: ${page.next}`] : []),
                        ].join('\n'),
                );
            },
        );

    knowledge
        .command('show')
        .description('Show one knowledge item by ID.')
        .argument('<id>', 'knowledge item ID (kn_...)')
        .option('--history', 'include previous versions, when the store has them')
        .option('--json', 'print one JSON document')
        .action(async (id: string, options: { history?: boolean; json?: boolean }) => {
            await withKnowledgeStore(
                context,
                options.json === true,
                () => {
                    const made = Knowledge.makeKnowledgeItemId(id);
                    if (!made.ok) throw new KnowledgeInputError(`Invalid knowledge item ID: ${id}.`);
                    return made.value;
                },
                async ({ store, project }, itemId) => {
                    const found = await store.get(project, itemId, { history: options.history === true });
                    if (!found) throw new KnowledgeInputError(`Knowledge item ${id} was not found.`);
                    return found;
                },
                (found) => showText(found, options.history === true),
            );
        });

    const write = async <T, O>(
        json: boolean,
        supplied: string | undefined,
        validate: () => T,
        action: (access: CliKnowledgeAccess, input: T, by: Knowledge.UserName) => Promise<O>,
        render: (value: O) => string,
    ): Promise<void> => {
        await withKnowledgeStore(
            context,
            json,
            validate,
            async (access, input, cfg) => {
                const by = actor(cfg, supplied);
                return action(access, input, by);
            },
            render,
        );
    };
    const common = (command: Command): Command => command.option('--actor <name>', 'self-asserted actor name').option('--json', 'print one JSON document');
    type WriteOptions = { actor?: string; json?: boolean };

    common(knowledge.command('edit').description('Edit an item title, text, labels, and about references in an editor.').argument('<id>')).action(
        async (id: string, options: WriteOptions) => {
            await write(
                options.json === true,
                options.actor,
                () => itemId(id),
                async ({ store, project }, input, by) => {
                    const found = await store.get(project, input);
                    if (!found) throw new KnowledgeInputError(`Knowledge item ${input} was not found.`);
                    const original = found.item;
                    const edited = await openEditor(
                        { id: original.id, version: original.version, ...original.content },
                        context.deps.env?.VISUAL ?? context.deps.env?.EDITOR ?? process.env.VISUAL ?? process.env.EDITOR ?? '',
                        context.deps.env,
                    );
                    const content = editedContent(edited, original.id, original.version);
                    return result(await store.correct(project, input, content, by, original.version));
                },
                (item) => `${item.id} updated to version ${item.version}.`,
            );
        },
    );

    common(
        knowledge
            .command('retire')
            .description('Retire an item.')
            .argument('<id>')
            .addOption(new Option('--reason <reason>').choices(['replaced', 'obsolete', 'wrong']))
            .option('--replaced-by <id>', 'replacement item ID'),
    ).action(async (id: string, options: WriteOptions & { reason?: Knowledge.RetirementReason; replacedBy?: string }) => {
        await write(
            options.json === true,
            options.actor,
            () => {
                const replacement = options.replacedBy && itemId(options.replacedBy);
                if (replacement && options.reason !== 'replaced') throw new KnowledgeInputError('--replaced-by requires --reason replaced.');
                return { id: itemId(id), retirement: { ...(options.reason && { reason: options.reason }), ...(replacement && { replacedBy: replacement }) } };
            },
            ({ store, project }, input, by) => store.retire(project, input.id, input.retirement, by).then(result),
            (item) => `${item.id} retired.`,
        );
    });

    common(knowledge.command('unretire').description('Undo an item retirement.').argument('<id>')).action(async (id: string, options: WriteOptions) => {
        await write(
            options.json === true,
            options.actor,
            () => itemId(id),
            ({ store, project }, input, by) => store.unretire(project, input, by).then(result),
            (item) => `${item.id} unretired.`,
        );
    });

    knowledge
        .command('proposals')
        .description('List open retirement proposals.')
        .option('--json', 'print one JSON document')
        .action(async (options: { json?: boolean }) => {
            await withKnowledgeStore(
                context,
                options.json === true,
                () => undefined,
                ({ store, project }) => store.proposals(project),
                (proposals) => (proposals.length ? proposals.map((p) => `${p.id}\t${p.action}\t${p.item}\t${p.explanation}`).join('\n') : 'No open proposals.'),
            );
        });

    for (const decision of ['approve', 'dismiss'] as const) {
        common(knowledge.command(decision).description(`${decision} a retirement proposal.`).argument('<proposal-id>')).action(
            async (id: string, options: WriteOptions) => {
                await write(
                    options.json === true,
                    options.actor,
                    () => proposalId(id),
                    ({ store, project }, input, by) =>
                        (decision === 'approve' ? store.approveProposal(project, input, by) : store.dismissProposal(project, input, by)).then(result),
                    () => `Proposal ${id} ${decision === 'approve' ? 'approved' : 'dismissed'}.`,
                );
            },
        );
    }

    common(
        knowledge.command('delete').description('Delete an item, with confirmation.').argument('<id>').option('--yes', 'skip interactive confirmation'),
    ).action(async (id: string, options: WriteOptions & { yes?: boolean }) => {
        await write(
            options.json === true,
            options.actor,
            () => itemId(id),
            async ({ store, project }, input, by) => {
                const found = await store.get(project, input);
                if (!found) throw new KnowledgeInputError(`Knowledge item ${input} was not found.`);
                if (!options.yes) {
                    if (!context.deps.confirm) throw new KnowledgeInputError('Deletion needs an interactive terminal or --yes.');
                    if (!(await context.deps.confirm(`Delete ${input} (${found.item.content.title})?`))) throw new KnowledgeInputError('Deletion cancelled.');
                }
                return { id: input, title: found.item.content.title, deletion: result(await store.delete(project, input, by)) };
            },
            (value) => `Deleted ${value.id} (${value.title}).`,
        );
    });

    common(knowledge.command('restore').description('Restore a deleted item.').argument('<id>')).action(async (id: string, options: WriteOptions) => {
        await write(
            options.json === true,
            options.actor,
            () => itemId(id),
            ({ store, project }, input, by) => store.restore(project, input, by).then(result),
            (item) => `${item.id} restored.`,
        );
    });
}
