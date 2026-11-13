import { Command, Option } from 'commander';
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
    action: (access: CliKnowledgeAccess, input: Input) => Promise<Output>,
    render: (value: Output) => string,
): Promise<void> {
    try {
        const input = validate();
        const cfg = await context.config();
        const approval = await checkApproved(cfg, context.deps.trust);
        if (!context.deps.openKnowledgeStore) throw new Error('Knowledge store access is unavailable.');
        const opened = await context.deps.openKnowledgeStore(cfg, approval);
        if (!opened.ok) throw new Error(opened.error.message);
        const value = await action(opened.value, input);
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

/** Registers the read-only knowledge CLI. Future subcommands use the same runner. */
export function registerKnowledgeCommand(program: Command, context: Context): void {
    const knowledge = program.command('knowledge').description('Read knowledge items from the configured store.');
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
}
