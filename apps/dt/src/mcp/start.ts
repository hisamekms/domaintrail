// `dt mcp` (ADR 0031, section 9): the MCP server over stdio with the knowledge tools, on the workspace's store
// (`openKnowledgeStore`) and its stormings, read again on every call.
import type { Readable, Writable } from 'node:stream';
import type { SourceFile } from '@domaintrail/kernel';
import { analyzeStormings, isStormingFile } from '@domaintrail/storming';
import { version } from '../../../../package.json' with { type: 'json' };
import type { McpServerStartOptions } from '../cli/ports.js';
import { openKnowledgeStore, type KnowledgeStoreOptions } from '../wiring/knowledge.js';
import { knowledgeTools, stickyIndex, type KnowledgeAccess, type StickyIndex } from './knowledge-tools.js';
import { serveMcp } from './protocol.js';

/** What the server says the client may tell the model about it. */
export const MCP_INSTRUCTIONS =
    "DomainTrail's knowledge of this project: what was said and found in its modeling sessions (why the model is so, rules, examples, terms, pains, wants, decisions), attached to the stickies of its Event Stormings. Before implementing or changing an element of the model, call knowledge_for_element with it (a sticky 'Storming.LocalId' or 'dt:Context.Aggregate.command'). Each item says how far to trust it (origin: said, agreed, investigated, inferred) and its date; items may conflict. Retired items (no longer true, wrong or replaced) are left out unless asked for. Read-only.";

export interface McpServerIO {
    /** The workspace's sources (`dt check`'s), read on every call. */
    readonly loadWorkspace: (root: string, sources: readonly string[], respectGitignore: boolean) => Promise<SourceFile[]>;
    readonly input?: Readable;
    readonly output?: Writable;
    /** The store's options (tests). */
    readonly store?: KnowledgeStoreOptions;
}

/** Serves `dt mcp` on stdin and stdout (or `io`'s streams) until the client closes stdin. */
export async function startMcpServer(options: McpServerStartOptions, io: McpServerIO): Promise<void> {
    const { config } = options;
    const opened = await openKnowledgeStore(config, options.approval, io.store);
    const access: KnowledgeAccess = opened.ok ? { store: opened.value.store, project: opened.value.project } : { unavailable: opened.error.message };
    if (!opened.ok) options.log(`dt mcp: ${opened.error.message}; the tools answer with this error`);
    const stickies = async (): Promise<StickyIndex> => {
        const sources = (await io.loadWorkspace(config.root, config.sources, config.respectGitignore)).filter((s) => isStormingFile(s.path));
        return stickyIndex((await analyzeStormings(sources, undefined)).stormings);
    };
    await serveMcp({
        name: 'domaintrail',
        version,
        instructions: MCP_INSTRUCTIONS,
        tools: knowledgeTools({ access, stickies, ...(options.withoutRetired && { withoutRetired: true }) }),
        input: io.input ?? process.stdin,
        output: io.output ?? process.stdout,
        log: options.log,
    });
}
