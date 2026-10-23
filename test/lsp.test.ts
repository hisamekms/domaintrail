import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { URI } from 'langium';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { runCli } from '../src/cli/main.js';

const BIN = path.join(import.meta.dir, '..', 'bin', 'dt.ts');

// each test starts a server process, which takes longer on a busy machine than the default 5 s allow
setDefaultTimeout(30_000);

interface PublishedDiagnostics {
    uri: string;
    diagnostics: { range: { start: { line: number; character: number } }; severity: number; code: string; message: string }[];
}

/** A language server started with `dt lsp` over stdio, and the diagnostics it last published per file. */
class Client {
    readonly diagnostics = new Map<string, PublishedDiagnostics['diagnostics']>();
    private readonly waiters: (() => void)[] = [];

    constructor(
        readonly root: string,
        private readonly process: ChildProcess,
        readonly connection: MessageConnection,
    ) {
        connection.onNotification('textDocument/publishDiagnostics', (p: PublishedDiagnostics) => {
            this.diagnostics.set(path.relative(root, URI.parse(p.uri).fsPath), p.diagnostics);
            for (const w of this.waiters.splice(0)) w();
        });
        connection.onRequest('client/registerCapability', () => null);
        connection.onRequest('workspace/configuration', () => []);
        connection.onNotification('window/showMessage', () => {});
        connection.onNotification('window/logMessage', () => {});
    }

    static async start(root: string, args: string[] = []): Promise<Client> {
        const child = spawn(process.execPath, [BIN, ...args, 'lsp'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
        const connection = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
        const client = new Client(root, child, connection);
        connection.listen();
        const uri = URI.file(root).toString();
        client.initializeResult = await connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri: uri,
            workspaceFolders: [{ uri, name: 'test' }],
            capabilities: { textDocument: { publishDiagnostics: {}, hover: { contentFormat: ['markdown'] }, rename: { prepareSupport: true } } },
        });
        await connection.sendNotification('initialized', {});
        return client;
    }

    initializeResult: unknown;

    uri(file: string): string {
        return URI.file(path.join(this.root, file)).toString();
    }

    /** Waits until the diagnostics published for `file` satisfy `ok`. */
    async until(file: string, ok: (d: PublishedDiagnostics['diagnostics']) => boolean): Promise<PublishedDiagnostics['diagnostics']> {
        const deadline = Date.now() + 10_000;
        while (!(this.diagnostics.has(file) && ok(this.diagnostics.get(file)!))) {
            if (Date.now() > deadline) throw new Error(`no matching diagnostics for ${file}: ${JSON.stringify(this.diagnostics.get(file))}`);
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
                setTimeout(resolve, 200);
            });
        }
        return this.diagnostics.get(file)!;
    }

    request<T>(method: string, file: string, position: { line: number; character: number }, extra: object = {}): Promise<T> {
        return this.connection.sendRequest(method, { textDocument: { uri: this.uri(file) }, position, ...extra });
    }

    async stop(): Promise<void> {
        await this.connection.sendRequest('shutdown');
        await this.connection.sendNotification('exit');
        await new Promise((resolve) => this.process.once('exit', resolve));
        this.connection.dispose();
    }
}

/** Position of the `n`th occurrence (0-based) of `needle` in `text`, plus `offset` characters. */
function at(text: string, needle: string, offset = 0, n = 0): { line: number; character: number } {
    let index = -1;
    for (let i = 0; i <= n; i++) index = text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`'${needle}' not found`);
    const before = text.slice(0, index + offset).split('\n');
    return { line: before.length - 1, character: before.at(-1)!.length };
}

const COMMON = `shared context Common {
  /// An amount in yen.
  value Money "金額" { amount: Decimal }
}
`;

const SALES = `context Sales "販売" {
  id OrderId: UUID
  aggregate Order "注文" {
    id: OrderId
    total: Money
    lines: OrderLine[0..*]
    state Draft
    state Placed
    /// An order is never free.
    invariant positive "正の金額" { total.amount > 0 }
    command place() Draft -> Placed emits OrderPlaced
  }
  value OrderLine { quantity: Int }
  event OrderPlaced { orderId: OrderId }
}
`;

const BILLING = `context Billing {
  id InvoiceId: UUID
  aggregate Invoice {
    id: InvoiceId
    references order: Sales.OrderId -> Sales.Order
    state Open
  }
}
`;

const dirs: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
    for (const c of clients.splice(0)) await c.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
    // the real path, as the server sees the directory it runs in (/var is /private/var on macOS)
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-lsp-')));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    return dir;
}

async function start(files: Record<string, string>, args: string[] = []): Promise<Client> {
    const client = await Client.start(await workspace(files), args);
    clients.push(client);
    return client;
}

/** The output of `dt check` for the same workspace, as `line:col code message` per diagnostic of `file`. */
async function checkOutput(root: string, file: string): Promise<string[]> {
    const lines: string[] = [];
    await runCli(['-r', root, 'check'], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    return lines.filter((l) => l.startsWith(`${file}:`)).map((l) => {
        const m = /^[^:]+:(\d+):(\d+) - (error|warning) (\S+): (.*)$/.exec(l)!;
        return `${m[1]}:${m[2]} ${m[3]} ${m[4]} ${m[5]}`;
    });
}

const asCheckLines = (d: PublishedDiagnostics['diagnostics']): string[] =>
    d.map((x) => `${x.range.start.line + 1}:${x.range.start.character + 1} ${x.severity === 1 ? 'error' : 'warning'} ${x.code} ${x.message}`);

describe('dt lsp', () => {
    test('answers initialize with the features it offers', async () => {
        const client = await start({ 'common.dt': COMMON });
        const { capabilities } = client.initializeResult as { capabilities: Record<string, unknown> };
        expect(capabilities).toMatchObject({
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            completionProvider: expect.any(Object),
        });
    });

    test('publishes the diagnostics of dt check, cross-file and rule-only ones included', async () => {
        const client = await start({
            'common.dt': COMMON,
            'sales.dt': SALES.replace('total.amount > 0', 'count(total) > 0'),
            'billing.dt': BILLING.replace('-> Sales.Order', '-> Sales.Missing'),
        });
        const billing = await client.until('billing.dt', (d) => d.length > 0);
        const sales = await client.until('sales.dt', (d) => d.length > 0);
        expect(sales.map((d) => d.code)).toEqual(['M009']);
        expect(billing.map((d) => d.code)).toEqual(['M001']);
        expect(asCheckLines(sales)).toEqual(await checkOutput(client.root, 'sales.dt'));
        expect(asCheckLines(billing)).toEqual(await checkOutput(client.root, 'billing.dt'));
        expect(await client.until('common.dt', () => true)).toEqual([]);
    });

    test('a rule over the whole workspace (M010) is reported, and follows unsaved edits', async () => {
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES, 'billing.dt': BILLING });
        await client.until('sales.dt', (d) => d.length === 0);
        // a field of one state used in an invariant of the whole aggregate
        const edited = SALES.replace('state Placed', 'state Placed { placedAt: Timestamp }').replace('total.amount > 0', 'exists(placedAt)');
        await client.connection.sendNotification('textDocument/didOpen', {
            textDocument: { uri: client.uri('sales.dt'), languageId: 'domaintrail', version: 1, text: edited },
        });
        const diagnostics = await client.until('sales.dt', (d) => d.length > 0);
        await writeFile(path.join(client.root, 'sales.dt'), edited);
        expect(asCheckLines(diagnostics)).toEqual(await checkOutput(client.root, 'sales.dt'));
        expect(diagnostics.map((d) => d.code)).toContain('M010');

        await client.connection.sendNotification('textDocument/didChange', {
            textDocument: { uri: client.uri('sales.dt'), version: 2 },
            contentChanges: [{ text: SALES }],
        });
        expect(await client.until('sales.dt', (d) => d.length === 0)).toEqual([]);
    });

    test('goes to definitions in other files and finds references across contexts', async () => {
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES, 'billing.dt': BILLING });
        await client.until('billing.dt', () => true);
        const definition = await client.request<{ targetUri: string; targetSelectionRange: { start: { line: number } } }[]>(
            'textDocument/definition',
            'billing.dt',
            at(BILLING, '-> Sales.Order', '-> Sales.'.length),
        );
        expect(definition.map((d) => [d.targetUri, d.targetSelectionRange.start.line])).toEqual([[client.uri('sales.dt'), at(SALES, 'aggregate Order').line]]);

        const shared = await client.request<{ targetUri: string }[]>('textDocument/definition', 'sales.dt', at(SALES, 'Money'));
        expect(shared.map((d) => d.targetUri)).toEqual([client.uri('common.dt')]);

        const refs = await client.request<{ uri: string; range: { start: { line: number } } }[]>(
            'textDocument/references',
            'sales.dt',
            at(SALES, 'OrderId'),
            { context: { includeDeclaration: false } },
        );
        expect(refs.map((r) => `${path.basename(URI.parse(r.uri).fsPath)}:${r.range.start.line}`).sort()).toEqual(
            [`billing.dt:${at(BILLING, 'Sales.OrderId').line}`, `sales.dt:${at(SALES, 'id: OrderId').line}`, `sales.dt:${at(SALES, 'orderId: OrderId').line}`].sort(),
        );
    });

    test('hovers show kind, label, description and the expression of an invariant', async () => {
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES, 'billing.dt': BILLING });
        await client.until('sales.dt', () => true);
        const hover = (file: string, pos: { line: number; character: number }) =>
            client.request<{ contents: { value: string } } | null>('textDocument/hover', file, pos).then((h) => h?.contents.value);
        expect(await hover('billing.dt', at(BILLING, '-> Sales.Order', '-> Sales.'.length))).toBe('**aggregate `Order`** 注文 — `Sales.Order`');
        expect(await hover('sales.dt', at(SALES, 'Money'))).toBe('**value `Money`** 金額 — `Common.Money`\n\nAn amount in yen.');
        expect(await hover('sales.dt', at(SALES, 'positive'))).toBe(
            '**invariant `positive`** 正の金額 — `Sales.Order`\n\nAn order is never free.\n\n```dt\n{ total.amount > 0 }\n```',
        );
        expect(await hover('sales.dt', at(SALES, 'total:'))).toBe('**field `total: Money`** 金額 — `Sales.Order`');
    });

    test('outlines declarations', async () => {
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES });
        await client.until('sales.dt', () => true);
        type Symbol = { name: string; children?: Symbol[] };
        const symbols = await client.connection.sendRequest<Symbol[]>('textDocument/documentSymbol', { textDocument: { uri: client.uri('sales.dt') } });
        const names = (s: Symbol[]): unknown[] => s.map((x) => (x.children ? [x.name, names(x.children)] : x.name));
        expect(names(symbols)).toEqual([
            ['Sales', ['OrderId', ['Order', ['id', 'total', 'lines', 'Draft', 'Placed', 'positive', 'place']], ['OrderLine', ['quantity']], ['OrderPlaced', ['orderId']]]],
        ]);
    });

    test('renames a declaration and its references in every file, keeping qualified names qualified', async () => {
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES, 'billing.dt': BILLING });
        await client.until('billing.dt', () => true);
        const range = await client.request<{ start: { character: number }; end: { character: number } }>(
            'textDocument/prepareRename',
            'billing.dt',
            at(BILLING, '-> Sales.Order', 4),
        );
        expect(BILLING.split('\n')[at(BILLING, 'Sales.Order').line].slice(range.start.character, range.end.character)).toBe('Order');

        const edit = await client.request<{ changes: Record<string, { range: { start: { line: number; character: number }; end: { character: number } }; newText: string }[]> }>(
            'textDocument/rename',
            'billing.dt',
            at(BILLING, '-> Sales.Order', 4),
            { newName: 'PurchaseOrder' },
        );
        const apply = (text: string, edits: (typeof edit.changes)[string] = []) => {
            const lines = text.split('\n');
            for (const e of [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
                const l = lines[e.range.start.line];
                lines[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
            }
            return lines.join('\n');
        };
        expect(apply(BILLING, edit.changes[client.uri('billing.dt')])).toBe(BILLING.replace('-> Sales.Order', '-> Sales.PurchaseOrder'));
        expect(apply(SALES, edit.changes[client.uri('sales.dt')])).toBe(SALES.replace('aggregate Order', 'aggregate PurchaseOrder'));

        // fields are also named in expressions, which are not references: not renamed
        expect(await client.request('textDocument/prepareRename', 'sales.dt', at(SALES, 'total:'))).toBeNull();
    });

    test('uses the config of --root and its sources', async () => {
        const dir = await workspace({});
        const root = path.join(dir, 'domain');
        await Bun.write(path.join(root, 'domaintrail.jsonc'), JSON.stringify({ sources: ['model/**/*.dt'] }));
        await Bun.write(path.join(root, 'model', 'sales.dt'), SALES.replace('total: Money', 'total: Missing'));
        await Bun.write(path.join(root, 'ignored.dt'), 'context {');
        const client = await Client.start(dir, ['-r', 'domain']);
        clients.push(client);
        const sales = await client.until(path.join('domain', 'model', 'sales.dt'), (d) => d.length > 0);
        expect(sales.map((d) => d.code)).toEqual(['M001']);
        expect(client.diagnostics.has(path.join('domain', 'ignored.dt'))).toBe(false);
    });
});
