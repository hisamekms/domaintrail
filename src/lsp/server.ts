import * as path from 'node:path';
import { format } from 'node:util';
import { AstUtils, CstUtils, DefaultWorkspaceManager, DocumentState, URI, inject, type AstNode, type FileSystemNode, type LangiumDocument, type LangiumSharedCoreServices } from 'langium';
import {
    AstNodeHoverProvider,
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
    type LangiumServices,
    type LangiumSharedServices,
} from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import {
    CompletionItemKind,
    DiagnosticSeverity,
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
import { analyze } from '../core/analyze.js';
import { ConfigError, DEFAULT_SOURCES, IGNORED_DIRS, loadConfig, sourceMatcher, type ResolvedConfig } from '../core/config.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { LabelResolver, docComment } from '../core/labels.js';
import { ModelIndex } from '../core/model-index.js';
import * as ast from '../language/generated/ast.js';
import { DomainGeneratedModule, DomainGeneratedSharedModule } from '../language/generated/module.js';
import { DomainModule } from '../language/domain-module.js';
import { formatDomain } from '../format/format.js';
import { elementIdOf } from '../model/ids.js';

export interface LanguageServerOptions {
    /** Explicit `--root`: where to look for the config, instead of the client's workspace folder. */
    root?: string;
    /** Explicit `--config` file. */
    configPath?: string;
}

/**
 * The workspace as `dt check` sees it: the config found from `--root`, else from the client's first workspace folder,
 * else from the current directory; its `sources` decide which files are loaded and checked.
 */
export class DomainWorkspace {
    config: ResolvedConfig = { root: process.cwd(), sources: DEFAULT_SOURCES, tsOut: '', tsContexts: {}, view: { port: 0, host: '' } };
    private matches = sourceMatcher(DEFAULT_SOURCES);

    constructor(private readonly options: LanguageServerOptions) {}

    async resolve(folder: string | undefined, warn: (message: string) => void): Promise<void> {
        const start = this.options.root ?? folder ?? process.cwd();
        try {
            this.config = await loadConfig({ start, configPath: this.options.configPath });
        } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            warn(`${e.message} (using the default sources ${DEFAULT_SOURCES.join(', ')} under ${start})`);
            this.config = { ...this.config, root: path.resolve(start) };
        }
        this.matches = sourceMatcher(this.config.sources);
    }

    /** Path of a file relative to the root, when it is one of the workspace's sources. */
    sourcePath(uri: URI): string | undefined {
        if (uri.scheme !== 'file') return undefined;
        const rel = path.relative(this.config.root, uri.fsPath);
        return rel.startsWith('..') || path.isAbsolute(rel) || !this.matches(rel) ? undefined : rel;
    }

    /** Directories walked when loading the workspace: those `dt check` walks. */
    includesDirectory(uri: URI): boolean {
        return !IGNORED_DIRS.has(path.basename(uri.fsPath));
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
 * and the `changes` and `emits` entries of a command (the events with their multiplicity and `when`).
 */
class DomainHoverProvider extends AstNodeHoverProvider {
    constructor(private readonly services: LangiumServices) {
        super(services);
    }

    protected override getAstNodeHoverContent(node: AstNode): string | undefined {
        const kind = kindOf(node);
        const name = (node as { name?: string }).name;
        if (!kind || !name) return undefined;
        const documents = this.services.shared.workspace.LangiumDocuments.all.map((d) => d.parseResult.value as ast.Model).toArray();
        const labels = new LabelResolver(new ModelIndex(documents));
        let title = `${kind} \`${name}\``;
        let label = (node as { label?: string }).label;
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
        const owner = ast.isContext(node) ? undefined : elementIdOf(ast.isState(node) || ast.isCommand(node) || ast.isContext(node.$container) ? node : node.$container);
        const lines = [`**${title}**${label ? ` ${label}` : ''}${owner ? ` — \`${owner}\`` : ''}`];
        if (doc) lines.push(doc);
        if (ast.isInvariant(node) && node.expr) lines.push(`\`\`\`dt\n{ ${cstText(node.expr)} }\n\`\`\``);
        if (ast.isCommand(node) && node.changes.length) lines.push(`\`\`\`dt\nchanges ${node.changes.join(', ')}\n\`\`\``);
        if (ast.isCommand(node) && node.emits.length) lines.push(`\`\`\`dt\nemits ${node.emits.map(cstText).join(', ')}\n\`\`\``);
        if (ast.isRequirement(node)) lines.push(`\`\`\`dt\n${node.expr ? `{ ${cstText(node.expr)} } ` : ''}else ${node.error?.$refText ?? ''}\n\`\`\``);
        return lines.join('\n\n');
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
        if (ast.isIdType(node) || ast.isPrimitiveDecl(node) || ast.isUnionDecl(node)) return SymbolKind.TypeParameter;
        if (ast.isEnumDecl(node)) return SymbolKind.Enum;
        if (ast.isEnumValue(node) || ast.isState(node)) return SymbolKind.EnumMember;
        if (ast.isEventDecl(node)) return SymbolKind.Event;
        if (ast.isCommand(node)) return SymbolKind.Method;
        if (ast.isParameter(node)) return SymbolKind.Variable;
        if (ast.isInvariant(node) || ast.isRequirement(node)) return SymbolKind.Boolean;
        return SymbolKind.Field;
    }

    override getCompletionItemKind(node: AstNode): CompletionItemKind {
        if (ast.isAggregate(node) || ast.isEntity(node)) return CompletionItemKind.Class;
        if (ast.isValueObject(node) || ast.isFieldSet(node) || ast.isErrorDecl(node)) return CompletionItemKind.Struct;
        if (ast.isEnumDecl(node)) return CompletionItemKind.Enum;
        if (ast.isState(node)) return CompletionItemKind.EnumMember;
        if (ast.isEventDecl(node)) return CompletionItemKind.Event;
        return CompletionItemKind.TypeParameter;
    }
}

const IDENTIFIER = /^[_a-zA-Z][\w_]*$/;

/**
 * Renames context elements and states: the declaration and every reference, in any file. A qualified reference
 * (`Sales.Order`) keeps its context. Other names (contexts, fields, parameters) are also used in places that are not
 * references (qualified names, expressions, terms), so they are not renamed.
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
        const ref = AstUtils.streamReferences(leaf.astNode).map((r) => r.reference.$refNode).find((n) => !!n && n.offset <= leaf.offset && leaf.end <= n.end);
        return lastSegment(document, (ref ?? leaf).range);
    }

    private leafAt(document: LangiumDocument, position: Position) {
        const root = document.parseResult.value.$cstNode;
        return CstUtils.findDeclarationNodeAtOffset(root, document.textDocument.offsetAt(position), this.grammarConfig.nameRegexp);
    }

    private target(document: LangiumDocument, position: Position): AstNode | undefined {
        const leaf = this.leafAt(document, position);
        const [target] = leaf ? this.references.findDeclarations(leaf) : [];
        return target && (ast.isState(target) || ast.isContext(target.$container)) ? target : undefined;
    }
}

/**
 * Document formatting: the whole file as `dt fmt` writes it, as one edit; nothing for a file with syntax errors. A range
 * is formatted as the whole file, since the layout of a line depends on its block; there is no on-type formatting.
 */
class DomainFormatter implements Formatter {
    formatDocument(document: LangiumDocument): TextEdit[] {
        const { lexerErrors, parserErrors } = document.parseResult;
        if (lexerErrors.length || parserErrors.length) return [];
        const text = document.textDocument.getText();
        const formatted = formatDomain(text);
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

/** The range of the last identifier in `range` (the name in `Context.Name`). */
function lastSegment(document: LangiumDocument, range: Range): Range {
    const text = document.textDocument.getText(range);
    const m = /[_a-zA-Z][\w_]*$/.exec(text);
    if (!m || m.index === 0) return range;
    const start = document.textDocument.positionAt(document.textDocument.offsetAt(range.start) + m.index);
    return { start, end: range.end };
}

export function createDomainLspServices(connection: Connection, options: LanguageServerOptions = {}) {
    const workspace = new DomainWorkspace(options);
    const warn = (message: string) => void connection.window.showWarningMessage(message);
    const shared = inject(createDefaultSharedModule({ connection, ...NodeFileSystem }), DomainGeneratedSharedModule, {
        workspace: { WorkspaceManager: (s: LangiumSharedServices) => new DomainWorkspaceManager(s, workspace, warn) },
        lsp: { NodeKindProvider: () => new DomainNodeKindProvider() },
    });
    const Domain = inject(createDefaultModule({ shared }), DomainGeneratedModule, DomainModule, {
        lsp: {
            HoverProvider: (s: LangiumServices) => new DomainHoverProvider(s),
            DocumentSymbolProvider: (s: LangiumServices) => new DomainDocumentSymbolProvider(s),
            RenameProvider: (s: LangiumServices) => new DomainRenameProvider(s),
            Formatter: () => new DomainFormatter(),
        },
    });
    shared.ServiceRegistry.register(Domain);
    return { shared, Domain, workspace };
}

/**
 * Starts the language server on `connection` (stdio by default). Like Langium's `startLanguageServer`, but with the
 * diagnostics of `dt check` instead of Langium's validation, and without the features the language does not provide.
 */
export function startLanguageServer(options: LanguageServerOptions = {}, connection: Connection = createConnection(process.stdin, process.stdout)) {
    // stdout carries the protocol: anything logged goes to the client instead.
    console.log = console.info = (...args: unknown[]) => connection.console.log(format(...args));
    const { shared, workspace } = createDomainLspServices(connection, options);
    const diagnostics = new DiagnosticsPublisher(shared, workspace, connection);
    shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedReferences, () => diagnostics.schedule());

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
