import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { format } from 'node:util';
import {
    AstUtils,
    CstUtils,
    DefaultWorkspaceManager,
    DocumentState,
    URI,
    inject,
    GrammarUtils,
    type AstNode,
    type CstNode,
    type FileSystemNode,
    type LangiumDocument,
    type LangiumSharedCoreServices,
} from 'langium';
import {
    AstNodeHoverProvider,
    DefaultDefinitionProvider,
    DefaultDocumentSymbolProvider,
    DefaultNodeKindProvider,
    DefaultRenameProvider,
    addCompletionHandler,
    addConfigurationChangeHandler,
    addDocumentHighlightHandler,
    addDocumentSymbolHandler,
    addDocumentUpdateHandler,
    addExecuteCommandHandler,
    addFileOperationHandler,
    addFindReferencesHandler,
    addFoldingRangeHandler,
    addFormattingHandler,
    addGoToDeclarationHandler,
    addGotoDefinitionHandler,
    addHoverHandler,
    addRenameHandler,
    addWorkspaceSymbolHandler,
    createDefaultModule,
    createDefaultSharedModule,
    type Formatter,
    type GoToLink,
    type LangiumServices,
    type LangiumSharedServices,
} from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import {
    CompletionItemKind,
    DiagnosticSeverity,
    MessageType,
    ShowMessageNotification,
    SymbolKind,
    createConnection,
    type Connection,
    type Diagnostic as LspDiagnostic,
    type DocumentSymbol,
    type InitializeParams,
    type Position,
    type Range,
    type RenameParams,
    type TextEdit,
    type TextDocumentPositionParams,
    type WorkspaceEdit,
    type WorkspaceFolder,
} from 'vscode-languageserver/node';
import { analyze } from '@domaintrail/modeling/core/analyze';
import { CONFIG_FILES, ConfigError, DEFAULT_SOURCES, defaultConfig, type ResolvedConfig } from '@domaintrail/modeling/core/config';
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';
import { LabelResolver, docComment } from '@domaintrail/modeling/core/labels';
import { ModelIndex, commandsOf } from '@domaintrail/modeling/core/model-index';
import * as ast from '@domaintrail/modeling/language/generated/ast';
import { DomainGeneratedModule, DomainGeneratedSharedModule, EventStormingGeneratedModule } from '@domaintrail/modeling/language/generated/module';
import { DomainModule } from '@domaintrail/modeling/language/domain-module';
import { EventStormingModule } from '@domaintrail/modeling/storming/language/module';
import { formatStorming } from '@domaintrail/modeling/storming/format';
import { formatDomain } from '@domaintrail/modeling/format/format';
import { elementIdOf } from '@domaintrail/modeling/model/ids';

export interface LanguageServerOptions {
    /** Explicit `--root`: where to look for the config, instead of the client's workspace folder. */
    root?: string;
    /** Explicit `--config` file. */
    configPath?: string;
}

/**
 * What the language server reads from the workspace, defined here on its side (ADR 0025): `cliDeps`
 * (`@domaintrail/composition/cli`) wires the adapters of `@domaintrail/workspace` in.
 */
export interface LanguageServerFiles {
    /** Resolves the configuration from `start` upwards, or from the explicit `configPath`; rejects with `ConfigError`. */
    loadConfig(opts: { start: string; configPath?: string }): Promise<ResolvedConfig>;
    /** Which files below `root` are sources, as `dt check` decides. */
    sourceScope(root: string, sources?: readonly string[], respectGitignore?: boolean): SourceScope;
    /** The sources below `root` (paths relative to it, sorted), as `dt check` finds them. */
    findDomainFiles(root: string, sources: readonly string[], respectGitignore: boolean): Promise<string[]>;
}

/** Which files below a root are the workspace's sources. */
export interface SourceScope {
    /** Whether the directory `dir` (absolute, below the root) is walked. */
    includesDirectory(dir: string): boolean;
    /** Path of `file` (absolute) relative to the root, when it is one of the sources. */
    sourcePath(file: string): string | undefined;
}

/**
 * The workspace as `dt check` sees it: the config found from `--root`, else from the client's first workspace folder,
 * else from the current directory; its `sources` (and `.gitignore`, unless `respectGitignore` is false) decide which
 * files are loaded and checked. When no config file is found there, the first `.dt` document opened below that
 * directory whose own directory or a parent (up to it) has a config file makes that config the workspace instead (see
 * `NearestConfig`). There is one workspace per session.
 */
export class DomainWorkspace {
    config: ResolvedConfig = { ...defaultConfig(process.cwd()), tsOut: '', view: { port: 0, host: '' } };
    /** Where the config was searched from: the nearest config of a document is only searched up to it. */
    start = process.cwd();
    /** Whether the search found no config file, so that the nearest config of an opened document may replace it. */
    adoptable = false;
    private scope: SourceScope;

    constructor(
        private readonly options: LanguageServerOptions,
        private readonly deps: LanguageServerFiles,
    ) {
        this.scope = deps.sourceScope(this.config.root);
    }

    async resolve(folder: string | undefined, warn: (message: string) => void): Promise<void> {
        this.start = path.resolve(this.options.root ?? folder ?? process.cwd());
        try {
            this.config = await this.deps.loadConfig({ start: this.start, configPath: this.options.configPath });
            this.adoptable = !this.config.file;
        } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            warn(`${e.message} (using the default sources ${DEFAULT_SOURCES.join(', ')} under ${this.start})`);
            this.config = { ...this.config, root: this.start };
        }
        this.scope = this.deps.sourceScope(this.config.root, this.config.sources, this.config.respectGitignore);
    }

    /** Makes the config file `file` the workspace's. Returns false, after warning, when it is invalid. */
    async adopt(file: string, warn: (message: string) => void): Promise<boolean> {
        try {
            this.config = await this.deps.loadConfig({ start: this.start, configPath: file });
        } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            warn(e.message);
            return false;
        }
        this.adoptable = false;
        this.scope = this.deps.sourceScope(this.config.root, this.config.sources, this.config.respectGitignore);
        return true;
    }

    /** The config file nearest to `file`: in its directory or a parent, up to where the config was searched from. */
    nearestConfig(file: string): string | undefined {
        const rel = path.relative(this.start, file);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
            for (const name of CONFIG_FILES) {
                const candidate = path.join(dir, name);
                if (existsSync(candidate)) return candidate;
            }
            if (dir === this.start || dir === path.dirname(dir)) return undefined;
        }
    }

    /** Path of a file relative to the root, when it is one of the workspace's sources. */
    sourcePath(uri: URI): string | undefined {
        return uri.scheme === 'file' ? this.scope.sourcePath(uri.fsPath) : undefined;
    }

    /** Directories walked when loading the workspace: those `dt check` walks. */
    includesDirectory(uri: URI): boolean {
        return this.scope.includesDirectory(uri.fsPath);
    }

    /** The sources of the workspace, as `dt check` finds them. */
    async files(): Promise<URI[]> {
        const { root, sources, respectGitignore } = this.config;
        return (await this.deps.findDomainFiles(root, sources, respectGitignore)).map((f) => URI.file(path.join(root, f)));
    }
}

/** Loads the files of the config's `sources` below its root, instead of every `.dt` file in the workspace folders. */
class DomainWorkspaceManager extends DefaultWorkspaceManager {
    private rootUri: string | undefined;

    constructor(
        services: LangiumSharedCoreServices,
        private readonly workspace: DomainWorkspace,
        private readonly warn: (message: string) => void,
    ) {
        super(services);
    }

    override initialize(params: InitializeParams): void {
        super.initialize(params);
        this.rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
    }

    protected override async performStartup(_folders: WorkspaceFolder[]): Promise<LangiumDocument[]> {
        const folder = this.rootUri ? URI.parse(this.rootUri) : undefined;
        await this.workspace.resolve(folder?.scheme === 'file' ? folder.fsPath : undefined, this.warn);
        return super.performStartup([{ name: 'root', uri: URI.file(this.workspace.config.root).toString() }]);
    }

    override shouldIncludeEntry(entry: FileSystemNode): boolean {
        if (entry.isDirectory) return this.workspace.includesDirectory(entry.uri);
        return entry.isFile && this.serviceRegistry.hasServices(entry.uri) && this.workspace.sourcePath(entry.uri) !== undefined;
    }
}

/**
 * The nearest-config rule: when the workspace has no config file and a `.dt` document is opened below the directory
 * the config was searched from, the config file nearest to the document (see `DomainWorkspace.nearestConfig`) becomes
 * the workspace's: its sources are loaded instead, and the diagnostics of the files no longer in the workspace are
 * cleared. A document under another config file than the workspace's afterwards gets no diagnostics, and a warning
 * says so once per config file.
 */
class NearestConfig {
    private queue: Promise<void> = Promise.resolve();
    private readonly warned = new Set<string>();

    constructor(
        private readonly shared: LangiumSharedServices,
        private readonly workspace: DomainWorkspace,
        private readonly diagnostics: DiagnosticsPublisher,
        private readonly warn: (message: string) => void,
    ) {}

    opened(uri: URI): void {
        this.queue = this.queue.then(() => this.check(uri)).catch((e) => console.error(e));
    }

    private async check(uri: URI): Promise<void> {
        await this.shared.workspace.WorkspaceManager.ready;
        if (uri.scheme !== 'file' || !this.shared.ServiceRegistry.hasServices(uri)) return;
        const file = this.workspace.nearestConfig(uri.fsPath);
        if (!file || file === this.workspace.config.file) return;
        if (this.workspace.adoptable) {
            if (await this.workspace.adopt(file, this.warn)) await this.reload();
            return;
        }
        if (this.warned.has(file)) return;
        this.warned.add(file);
        const active = this.workspace.config.file ?? `${this.workspace.config.root} (no config file)`;
        this.warn(
            `${uri.fsPath} belongs to ${file}, not to the workspace of this session (${active}): its diagnostics are not computed. ` +
                `Open ${path.dirname(file)} as its own project to check it.`,
        );
    }

    /** Loads the workspace's sources, and unloads the other documents except open ones. */
    private async reload(): Promise<void> {
        const { LangiumDocuments, DocumentBuilder, TextDocuments, WorkspaceLock } = this.shared.workspace;
        const wanted = await this.workspace.files();
        const keep = new Set([...wanted.map((u) => u.toString()), ...TextDocuments.all().map((d) => d.uri)]);
        const deleted = LangiumDocuments.all
            .filter((d) => !keep.has(d.uri.toString()))
            .map((d) => d.uri)
            .toArray();
        const added = wanted.filter((u) => !LangiumDocuments.hasDocument(u));
        await WorkspaceLock.write((token) => DocumentBuilder.update(added, deleted, token));
        this.diagnostics.schedule();
    }
}

/**
 * Publishes the diagnostics of `dt check`, computed by `analyze` over the workspace's sources (with the unsaved text of
 * open documents) after every build. Langium's own validation results are never sent.
 */
class DiagnosticsPublisher {
    private published = new Set<string>();
    private pending = false;
    private running: Promise<void> | undefined;

    constructor(
        private readonly shared: LangiumSharedServices,
        private readonly workspace: DomainWorkspace,
        private readonly connection: Connection,
    ) {}

    schedule(): void {
        this.pending = true;
        this.running ??= this.loop().finally(() => (this.running = undefined));
    }

    private async loop(): Promise<void> {
        while (this.pending) {
            this.pending = false;
            await this.publish();
        }
    }

    private async publish(): Promise<void> {
        const uriOf = new Map<string, string>();
        const sources = [];
        for (const doc of this.shared.workspace.LangiumDocuments.all) {
            const rel = this.workspace.sourcePath(doc.uri);
            if (rel === undefined || uriOf.has(rel)) continue;
            uriOf.set(rel, doc.uri.toString());
            sources.push({ path: rel, text: doc.textDocument.getText() });
        }
        sources.sort((a, b) => a.path.localeCompare(b.path));
        const analysis = await analyze(sources);
        // every source gets a (possibly empty) list, so that a client sees each file checked
        const byUri = new Map<string, LspDiagnostic[]>([...uriOf.values()].map((uri) => [uri, []]));
        for (const d of analysis.diagnostics) {
            const uri = uriOf.get(d.file) ?? URI.file(path.resolve(this.workspace.config.root, d.file)).toString();
            byUri.set(uri, [...(byUri.get(uri) ?? []), toLspDiagnostic(d)]);
        }
        for (const uri of new Set([...this.published, ...byUri.keys()])) {
            await this.connection.sendDiagnostics({ uri, diagnostics: byUri.get(uri) ?? [] });
        }
        this.published = new Set(byUri.keys());
    }
}

/**
 * The hint is appended to the message as a second line, as `dt check` prints it: clients show the message (and agents
 * read it), while `relatedInformation` needs a location and is shown less prominently or not at all. `data` also carries
 * it on its own.
 */
export function toLspDiagnostic(d: Diagnostic): LspDiagnostic {
    return {
        range: {
            start: { line: d.start.line - 1, character: d.start.column - 1 },
            end: { line: d.end.line - 1, character: d.end.column - 1 },
        },
        severity: d.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        code: d.code,
        source: 'dt',
        message: d.hint ? `${d.message}\nhint: ${d.hint}` : d.message,
        data: { ...(d.elementId ? { elementId: d.elementId } : {}), ...(d.hint ? { hint: d.hint } : {}) },
    };
}

/** What a declaration is called in hovers. */
function kindOf(node: AstNode): string | undefined {
    if (ast.isContext(node)) return node.shared ? 'shared context' : 'context';
    if (ast.isIdType(node)) return 'id';
    if (ast.isPrimitiveDecl(node)) return 'primitive';
    if (ast.isVerifiedDecl(node)) return 'verified';
    if (ast.isEnumDecl(node)) return 'enum';
    if (ast.isEnumValue(node)) return 'enum value';
    if (ast.isValueObject(node)) return 'value';
    if (ast.isFieldSet(node)) return 'field set';
    if (ast.isUnionDecl(node)) return 'union';
    if (ast.isVariant(node)) return 'variant';
    if (ast.isEntity(node)) return 'entity';
    if (ast.isAggregate(node)) return 'aggregate';
    if (ast.isState(node)) return 'state';
    if (ast.isCommand(node)) return node.factory ? 'create command' : 'command';
    if (ast.isEventDecl(node)) return node.persistent ? 'persistent event' : 'event';
    if (ast.isErrorDecl(node)) return 'error';
    if (ast.isPolicy(node)) return 'policy';
    if (ast.isField(node)) return 'field';
    if (ast.isOwnsField(node)) return 'owns';
    if (ast.isReferenceField(node)) return 'references';
    if (ast.isParameter(node)) return 'parameter';
    if (ast.isInvariant(node)) return 'invariant';
    if (ast.isRequirement(node)) return 'requirement';
    if (ast.isTermEntry(node)) return 'term';
    return undefined;
}

const cstText = (node: AstNode | undefined): string => node?.$cstNode?.text ?? '';

/**
 * Hover: kind, name (with type for fields), label, `///` description, the expression of an invariant or requirement,
 * what a verified type verifies (`of`, `for`, `errors`), the `changes` and `emits` entries of a command (the events with
 * their multiplicity and `when`) and the policies that run it, the reaction of a policy, and the policies that react to
 * an event.
 */
class DomainHoverProvider extends AstNodeHoverProvider {
    constructor(private readonly services: LangiumServices) {
        super(services);
    }

    protected override getAstNodeHoverContent(node: AstNode): string | undefined {
        const kind = kindOf(node);
        const name = 'name' in node && typeof node.name === 'string' ? node.name : undefined;
        if (!kind || !name) return undefined;
        const documents = this.services.shared.workspace.LangiumDocuments.all
            .map((d) => d.parseResult.value)
            .filter(ast.isModel)
            .toArray();
        const labels = new LabelResolver(new ModelIndex(documents));
        let title = `${kind} \`${name}\``;
        let label = 'label' in node && typeof node.label === 'string' ? node.label : undefined;
        let doc = docComment(node);
        if (ast.isContext(node)) {
            label = labels.contextLabel(name);
            doc = labels.contextDoc(name);
        } else if (ast.isField(node) || ast.isOwnsField(node) || ast.isReferenceField(node) || ast.isParameter(node)) {
            const target = ast.isReferenceField(node) ? ` -> ${cstText(node.target?.$refNode?.astNode) || node.target?.$refText}` : '';
            title = `${kind} \`${name}: ${cstText(node.type)}${cstText(node.multiplicity)}${target}\``;
            label = labels.fieldLabel(node)?.label;
            doc = labels.fieldDoc(node);
        }
        const owner = ast.isContext(node)
            ? undefined
            : elementIdOf(ast.isState(node) || ast.isCommand(node) || ast.isContext(node.$container) ? node : node.$container);
        const lines = [`**${title}**${label ? ` ${label}` : ''}${owner ? ` — \`${owner}\`` : ''}`];
        if (doc) lines.push(doc);
        if (ast.isInvariant(node) && node.expr) lines.push(`\`\`\`dt\n{ ${cstText(node.expr)} }\n\`\`\``);
        if (ast.isCommand(node) && node.changes.length) lines.push(`\`\`\`dt\nchanges ${node.changes.join(', ')}\n\`\`\``);
        if (ast.isCommand(node) && node.emits.length) lines.push(`\`\`\`dt\nemits ${node.emits.map(cstText).join(', ')}\n\`\`\``);
        if (ast.isVerifiedDecl(node)) {
            const errors = node.errors.length ? ` errors ${node.errors.map((e) => e.$refText).join(', ')}` : '';
            lines.push(
                `\`\`\`dt\nof ${cstText(node.base)}${node.context ? ` for ${cstText(node.context)}${node.contextOptional ? '?' : ''}` : ''}${errors}\n\`\`\``,
            );
        }
        if (ast.isRequirement(node)) lines.push(`\`\`\`dt\n${node.expr ? `{ ${cstText(node.expr)} } ` : ''}else ${node.error?.$refText ?? ''}\n\`\`\``);
        if (ast.isPolicy(node)) {
            lines.push(`\`\`\`dt\nwhen ${node.event.$refText} -> ${node.aggregate.$refText}.${node.command.$refText}\n\`\`\``);
            lines.push('After the event, the command is run — eventually, by any mechanism.');
        }
        const policies = ast.isCommand(node) || ast.isEventDecl(node) ? this.policiesOf(node) : [];
        if (policies.length) {
            const what = ast.isCommand(node) ? 'Run by' : 'Reacted to by';
            lines.push(
                `${what} ${policies.map((p) => `policy \`${p.$container.name}.${p.name}\`${ast.isCommand(node) ? ` (when ${p.event.$refText})` : ` (-> ${p.aggregate.$refText}.${p.command.$refText})`}`).join(', ')}`,
            );
        }
        return lines.join('\n\n');
    }

    /** The policies that run a command or react to an event, in any file. */
    private policiesOf(node: ast.Command | ast.EventDecl): ast.Policy[] {
        const all = this.services.shared.workspace.LangiumDocuments.all
            .map((d) => d.parseResult.value)
            .filter(ast.isModel)
            .flatMap((m) => m.contexts.flatMap((c) => c.elements.filter(ast.isPolicy)))
            .toArray();
        return all.filter((p) => (ast.isCommand(node) ? p.command.ref === node : p.event.ref === node));
    }
}

/** Declarations shown in the outline (names inside expressions and terms are not declarations). */
const isOutlined = (node: AstNode): boolean => !ast.isNameRef(node) && !ast.isLambdaParam(node) && !ast.isTermEntry(node) && kindOf(node) !== undefined;

class DomainDocumentSymbolProvider extends DefaultDocumentSymbolProvider {
    protected override getSymbol(document: LangiumDocument, node: AstNode): DocumentSymbol[] {
        if (!ast.isModel(node) && !isOutlined(node)) return [];
        return super.getSymbol(document, node);
    }
}

class DomainNodeKindProvider extends DefaultNodeKindProvider {
    override getSymbolKind(node: AstNode): SymbolKind {
        if (ast.isContext(node)) return SymbolKind.Namespace;
        if (ast.isAggregate(node) || ast.isEntity(node)) return SymbolKind.Class;
        if (ast.isValueObject(node) || ast.isFieldSet(node) || ast.isVariant(node) || ast.isErrorDecl(node)) return SymbolKind.Struct;
        if (ast.isIdType(node) || ast.isPrimitiveDecl(node) || ast.isVerifiedDecl(node) || ast.isUnionDecl(node)) return SymbolKind.TypeParameter;
        if (ast.isEnumDecl(node)) return SymbolKind.Enum;
        if (ast.isEnumValue(node) || ast.isState(node)) return SymbolKind.EnumMember;
        if (ast.isEventDecl(node) || ast.isEsEvent(node)) return SymbolKind.Event;
        if (ast.isPolicy(node) || ast.isEsPolicy(node)) return SymbolKind.Interface;
        if (ast.isCommand(node) || ast.isEsCommand(node)) return SymbolKind.Method;
        if (ast.isEsStorming(node)) return SymbolKind.Namespace;
        if (ast.isEsAggregate(node)) return SymbolKind.Class;
        if (ast.isEsTimeline(node) || ast.isEsGroup(node)) return SymbolKind.Array;
        if (ast.isEsActor(node) || ast.isEsExternal(node) || ast.isEsReadModel(node)) return SymbolKind.Object;
        if (ast.isEsHotspot(node)) return SymbolKind.Key;
        if (ast.isParameter(node)) return SymbolKind.Variable;
        if (ast.isInvariant(node) || ast.isRequirement(node)) return SymbolKind.Boolean;
        return SymbolKind.Field;
    }

    override getCompletionItemKind(node: AstNode): CompletionItemKind {
        if (ast.isAggregate(node) || ast.isEntity(node)) return CompletionItemKind.Class;
        if (ast.isValueObject(node) || ast.isFieldSet(node) || ast.isErrorDecl(node)) return CompletionItemKind.Struct;
        if (ast.isEnumDecl(node)) return CompletionItemKind.Enum;
        if (ast.isState(node)) return CompletionItemKind.EnumMember;
        if (ast.isEventDecl(node) || ast.isEsEvent(node)) return CompletionItemKind.Event;
        if (ast.isEsDeclaration(node)) return CompletionItemKind.Reference;
        return CompletionItemKind.TypeParameter;
    }
}

const IDENTIFIER = /^[_a-zA-Z][\w_]*$/;

/**
 * Renames context elements, states and commands: the declaration and every reference, in any file (a command is
 * referenced by policies, `-> Invoice.issue`). A qualified reference (`Sales.Order`) keeps its context. Other names
 * (contexts, fields, parameters) are also used in places that are not references (qualified names, expressions,
 * terms), so they are not renamed.
 */
class DomainRenameProvider extends DefaultRenameProvider {
    constructor(private readonly services: LangiumServices) {
        super(services);
    }

    override async rename(document: LangiumDocument, params: RenameParams): Promise<WorkspaceEdit | undefined> {
        const target = this.target(document, params.position);
        if (!target || !IDENTIFIER.test(params.newName)) return undefined;
        const changes: Record<string, { range: Range; newText: string }[]> = {};
        for (const ref of this.references.findReferences(target, { includeDeclaration: true })) {
            const source = this.services.shared.workspace.LangiumDocuments.getDocument(ref.sourceUri);
            if (!source) continue;
            const uri = ref.sourceUri.toString();
            (changes[uri] ??= []).push({ range: lastSegment(source, ref.segment.range), newText: params.newName });
        }
        return { changes };
    }

    override prepareRename(document: LangiumDocument, params: TextDocumentPositionParams): Range | undefined {
        const leaf = this.leafAt(document, params.position);
        if (!leaf || !this.target(document, params.position)) return undefined;
        // on a qualified reference, the name after the context
        const ref = AstUtils.streamReferences(leaf.astNode)
            .map((r) => r.reference.$refNode)
            .find((n) => !!n && n.offset <= leaf.offset && leaf.end <= n.end);
        return lastSegment(document, (ref ?? leaf).range);
    }

    private leafAt(document: LangiumDocument, position: Position) {
        const root = document.parseResult.value.$cstNode;
        return CstUtils.findDeclarationNodeAtOffset(root, document.textDocument.offsetAt(position), this.grammarConfig.nameRegexp);
    }

    private target(document: LangiumDocument, position: Position): AstNode | undefined {
        const leaf = this.leafAt(document, position);
        const [target] = leaf ? this.references.findDeclarations(leaf) : [];
        return target && (ast.isState(target) || ast.isCommand(target) || ast.isContext(target.$container)) ? target : undefined;
    }
}

/**
 * Document formatting: the whole file as `dt fmt` writes it, as one edit; nothing for a file with syntax errors. A range
 * is formatted as the whole file, since the layout of a line depends on its block; there is no on-type formatting.
 */
class DomainFormatter implements Formatter {
    constructor(private readonly format: (text: string) => string) {}

    formatDocument(document: LangiumDocument): TextEdit[] {
        const { lexerErrors, parserErrors } = document.parseResult;
        if (lexerErrors.length || parserErrors.length) return [];
        const text = document.textDocument.getText();
        const formatted = this.format(text);
        if (formatted === text) return [];
        return [{ range: { start: { line: 0, character: 0 }, end: document.textDocument.positionAt(text.length) }, newText: formatted }];
    }

    formatDocumentRange(document: LangiumDocument): TextEdit[] {
        return this.formatDocument(document);
    }

    formatDocumentOnType(): TextEdit[] {
        return [];
    }

    get formatOnTypeOptions(): undefined {
        return undefined;
    }
}

/** What a `.dtes` declaration is called in hovers. */
function stormingKindOf(node: AstNode): string | undefined {
    if (ast.isEsStorming(node)) return 'storming';
    if (ast.isEsEvent(node)) return 'event';
    if (ast.isEsActor(node)) return 'actor';
    if (ast.isEsExternal(node)) return 'external';
    if (ast.isEsCommand(node)) return 'command';
    if (ast.isEsPolicy(node)) return 'policy';
    if (ast.isEsAggregate(node)) return 'aggregate';
    if (ast.isEsReadModel(node)) return 'read model';
    if (ast.isEsHotspot(node)) return 'hotspot';
    if (ast.isEsTimeline(node)) return 'timeline';
    if (ast.isEsGroup(node)) return 'group';
    return undefined;
}

/** Hover in a `.dtes` file: kind, ID, label, `///` description, the storming, and the `.dt` `ref` as written. */
class StormingHoverProvider extends AstNodeHoverProvider {
    protected override getAstNodeHoverContent(node: AstNode): string | undefined {
        const kind = stormingKindOf(node);
        if (!kind || !(ast.isEsDeclaration(node) || ast.isEsStorming(node))) return undefined;
        const storming = ast.isEsStorming(node) ? undefined : AstUtils.getContainerOfType(node, ast.isEsStorming);
        const lines = [`**${kind} \`${node.name}\`**${node.label ? ` ${node.label}` : ''}${storming ? ` — storming \`${storming.name}\`` : ''}`];
        const doc = docComment(node);
        if (doc) lines.push(doc);
        const refs = ast.isEsNode(node) ? node.clauses.filter(ast.isEsRefClause) : [];
        if (refs.length) lines.push(`\`\`\`dtes\n${refs.map((r) => `ref ${r.path}`).join('\n')}\n\`\`\``);
        return lines.join('\n\n');
    }
}

/**
 * Go to definition in a `.dtes` file: local references through Langium's linking, and each segment of a `.dt` `ref`
 * (`Sales.Order.place`) to what it names in the `.dt` files: the context, the element, the command of the aggregate.
 */
class StormingDefinitionProvider extends DefaultDefinitionProvider {
    constructor(private readonly services: LangiumServices) {
        super(services);
    }

    protected override findLinks(source: CstNode): GoToLink[] {
        const clause = source.astNode;
        if (!ast.isEsRefClause(clause)) return super.findLinks(source);
        const path = clause.$cstNode && GrammarUtils.findNodeForProperty(clause.$cstNode, 'path');
        const names = path
            ? CstUtils.flattenCst(path)
                  .filter((n) => !n.hidden && n.text !== '.')
                  .toArray()
            : [];
        const segment = names.findIndex((n) => n.offset === source.offset);
        if (segment < 0) return [];
        const models = this.services.shared.workspace.LangiumDocuments.all
            .map((d) => d.parseResult.value)
            .filter(ast.isModel)
            .toArray();
        const index = new ModelIndex(models);
        const [ctx, element, command] = names.map((n) => n.text);
        let target: AstNode | undefined;
        if (segment === 0) target = index.fragments.find((c) => c.name === ctx);
        else {
            const el = index.lookup(`${ctx}.${element}`);
            target = segment === 1 ? el : el && ast.isAggregate(el) ? commandsOf(el).find((c) => c.name === command) : undefined;
        }
        const targetName = target?.$cstNode && GrammarUtils.findNodeForProperty(target.$cstNode, 'name');
        const targetDocument = target && AstUtils.getDocument(target);
        return targetName && targetDocument ? [{ source, target: targetName, targetDocument }] : [];
    }
}

/** The range of the last identifier in `range` (the name in `Context.Name`). */
function lastSegment(document: LangiumDocument, range: Range): Range {
    const text = document.textDocument.getText(range);
    const m = /[_a-zA-Z][\w_]*$/.exec(text);
    if (!m || m.index === 0) return range;
    const start = document.textDocument.positionAt(document.textDocument.offsetAt(range.start) + m.index);
    return { start, end: range.end };
}

export function createDomainLspServices(connection: Connection, options: LanguageServerOptions, files: LanguageServerFiles) {
    const workspace = new DomainWorkspace(options, files);
    const warn = (message: string) => void connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Warning, message });
    const shared = inject(createDefaultSharedModule({ connection, ...NodeFileSystem }), DomainGeneratedSharedModule, {
        workspace: { WorkspaceManager: (s: LangiumSharedServices) => new DomainWorkspaceManager(s, workspace, warn) },
        lsp: { NodeKindProvider: () => new DomainNodeKindProvider() },
    });
    const Domain = inject(createDefaultModule({ shared }), DomainGeneratedModule, DomainModule, {
        lsp: {
            HoverProvider: (s: LangiumServices) => new DomainHoverProvider(s),
            DocumentSymbolProvider: (s: LangiumServices) => new DomainDocumentSymbolProvider(s),
            RenameProvider: (s: LangiumServices) => new DomainRenameProvider(s),
            Formatter: () => new DomainFormatter(formatDomain),
        },
    });
    shared.ServiceRegistry.register(Domain);
    const EventStorming = inject(createDefaultModule({ shared }), EventStormingGeneratedModule, EventStormingModule, {
        lsp: {
            HoverProvider: (s: LangiumServices) => new StormingHoverProvider(s),
            DefinitionProvider: (s: LangiumServices) => new StormingDefinitionProvider(s),
            Formatter: () => new DomainFormatter(formatStorming),
        },
    });
    shared.ServiceRegistry.register(EventStorming);
    return { shared, Domain, EventStorming, workspace, warn };
}

/**
 * Starts the language server on `connection` (stdio by default). Like Langium's `startLanguageServer`, but with the
 * diagnostics of `dt check` instead of Langium's validation, and without the features the language does not provide.
 */
export function startLanguageServer(
    options: LanguageServerOptions,
    files: LanguageServerFiles,
    connection: Connection = createConnection(process.stdin, process.stdout),
) {
    // stdout carries the protocol: anything logged goes to the client instead.
    console.log = console.info = (...args: unknown[]) => connection.console.log(format(...args));
    const { shared, workspace, warn } = createDomainLspServices(connection, options, files);
    const diagnostics = new DiagnosticsPublisher(shared, workspace, connection);
    shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedReferences, () => diagnostics.schedule());
    const nearest = new NearestConfig(shared, workspace, diagnostics, warn);
    shared.workspace.TextDocuments.onDidOpen((e) => nearest.opened(URI.parse(e.document.uri)));

    addDocumentUpdateHandler(connection, shared);
    addFileOperationHandler(connection, shared);
    addCompletionHandler(connection, shared);
    addFindReferencesHandler(connection, shared);
    addDocumentSymbolHandler(connection, shared);
    addGotoDefinitionHandler(connection, shared);
    addGoToDeclarationHandler(connection, shared);
    addDocumentHighlightHandler(connection, shared);
    addFoldingRangeHandler(connection, shared);
    addFormattingHandler(connection, shared);
    addRenameHandler(connection, shared);
    addHoverHandler(connection, shared);
    addWorkspaceSymbolHandler(connection, shared);
    addExecuteCommandHandler(connection, shared);
    addConfigurationChangeHandler(connection, shared);
    connection.onInitialize((params) => shared.lsp.LanguageServer.initialize(params));
    connection.onInitialized((params) => shared.lsp.LanguageServer.initialized(params));
    shared.workspace.TextDocuments.listen(connection);
    connection.listen();
    return { shared, workspace, connection };
}
