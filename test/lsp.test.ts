import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { URI } from 'langium';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { runCli } from '../src/cli/main.js';
import { formatDomain } from '../src/format/format.js';

const BIN = path.join(import.meta.dir, '..', 'bin', 'dt.ts');

// each test starts a server process, which takes longer on a busy machine than the default 5 s allow
setDefaultTimeout(30_000);

interface PublishedDiagnostics {
    uri: string;
    diagnostics: { range: { start: { line: number; character: number } }; severity: number; code: string; message: string; data?: { hint?: string } }[];
}

/** A language server started with `dt lsp` over stdio, and the diagnostics it last published per file. */
class Client {
    readonly diagnostics = new Map<string, PublishedDiagnostics['diagnostics']>();
    /** The messages of `window/showMessage`. */
    readonly messages: string[] = [];
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
        connection.onNotification('window/showMessage', (p: { message: string }) => void this.messages.push(p.message));
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

    open(file: string, text: string): Promise<void> {
        return this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: this.uri(file), languageId: 'domaintrail', version: 1, text } });
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

/** The diagnostics of `dt check --format json` for one file of the same workspace, as `line:col severity code message`. */
async function checkOutput(root: string, file: string): Promise<string[]> {
    const lines: string[] = [];
    await runCli(['-r', root, 'check', '--format', 'json'], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    const { diagnostics } = JSON.parse(lines.join('\n')) as { diagnostics: { file: string; line: number; column: number; severity: string; code: string; message: string; hint?: string }[] };
    return diagnostics
        .filter((d) => d.file === file)
        .map((d) => `${d.line}:${d.column} ${d.severity} ${d.code} ${d.message}${d.hint ? `\nhint: ${d.hint}` : ''}`);
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
            documentFormattingProvider: true,
        });
    });

    test('formats a document as dt fmt does, and leaves one with syntax errors alone', async () => {
        const client = await start({ 'common.dt': COMMON, 'broken.dt': 'context Broken { id X UUID }\n' });
        await client.until('broken.dt', () => true);
        const format = (file: string) =>
            client.connection.sendRequest<{ newText: string }[]>('textDocument/formatting', { textDocument: { uri: client.uri(file) }, options: { tabSize: 2, insertSpaces: true } });
        expect((await format('common.dt')).map((e) => e.newText)).toEqual([formatDomain(COMMON)]);
        expect(formatDomain(COMMON)).not.toBe(COMMON);
        expect(await format('broken.dt')).toEqual([]);
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

    test('appends the hint of a diagnostic to its message, and carries it in data', async () => {
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES.replace('Draft -> Placed', 'Draft -> Placd') });
        const [d] = await client.until('sales.dt', (d) => d.length > 0);
        expect(d).toMatchObject({
            code: 'M006',
            message: "Cannot resolve state 'Placd' in this aggregate.\nhint: did you mean 'Placed'?",
            data: { hint: "did you mean 'Placed'?" },
        });
        expect(asCheckLines([d])).toEqual(await checkOutput(client.root, 'sales.dt'));
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

    test('hovers on a command list its emits entries; renaming a state renames it in `when` too', async () => {
        const sales = SALES.replace('emits OrderPlaced', 'emits OrderPlaced[1..*] when Draft -> Placed');
        const client = await start({ 'common.dt': COMMON, 'sales.dt': sales });
        expect(await client.until('sales.dt', () => true)).toEqual([]);
        const hover = await client.request<{ contents: { value: string } } | null>('textDocument/hover', 'sales.dt', at(sales, 'place'));
        expect(hover?.contents.value).toBe('**command `place`** — `Sales.Order:place`\n\n```dt\nemits OrderPlaced[1..*] when Draft -> Placed\n```');
        const edit = await client.request<{ changes: Record<string, { range: { start: { line: number; character: number }; end: { character: number } }; newText: string }[]> }>(
            'textDocument/rename',
            'sales.dt',
            at(sales, 'state Placed', 'state '.length),
            { newName: 'Ordered' },
        );
        const edits = edit.changes[client.uri('sales.dt')];
        expect(edits.map((e) => [e.range.start.line, sales.split('\n')[e.range.start.line].slice(e.range.start.character, e.range.end.character)])).toEqual(
            expect.arrayContaining([
                [at(sales, 'state Placed').line, 'Placed'],
                [at(sales, 'when Draft').line, 'Placed'],
            ]),
        );
        expect(edits.filter((e) => e.range.start.line === at(sales, 'when Draft').line)).toHaveLength(2); // the transition and `when`
    });

    test('a verified type: hover with what it verifies, in the outline, renamed with its uses', async () => {
        const sales = `context Sales {
  id CustomerId: UUID
  /// Used by no other customer.
  verified AvailableEmail "未使用" of String for CustomerId? errors EmailTaken
  aggregate Customer {
    id: CustomerId
    email: String
    command changeEmail(email: AvailableEmail) changes email
  }
  error EmailTaken
}
`;
        const client = await start({ 'sales.dt': sales });
        expect(await client.until('sales.dt', () => true)).toEqual([]);
        const hover = await client.request<{ contents: { value: string } } | null>('textDocument/hover', 'sales.dt', at(sales, 'AvailableEmail'));
        expect(hover?.contents.value).toBe('**verified `AvailableEmail`** 未使用 — `Sales.AvailableEmail`\n\nUsed by no other customer.\n\n```dt\nof String for CustomerId? errors EmailTaken\n```');
        type Symbol = { name: string; children?: Symbol[] };
        const symbols = await client.connection.sendRequest<Symbol[]>('textDocument/documentSymbol', { textDocument: { uri: client.uri('sales.dt') } });
        expect(symbols[0].children?.map((x) => x.name)).toEqual(['CustomerId', 'AvailableEmail', 'Customer', 'EmailTaken']);
        const edit = await client.request<{ changes: Record<string, { range: { start: { line: number } } }[]> }>('textDocument/rename', 'sales.dt', at(sales, 'AvailableEmail'), {
            newName: 'FreeEmail',
        });
        expect(edit.changes[client.uri('sales.dt')].map((e) => e.range.start.line).sort()).toEqual([at(sales, 'AvailableEmail').line, at(sales, 'email: AvailableEmail').line]);
    });

    test('hovers on a command list its changes; the outline and renames are unaffected by them', async () => {
        const sales = SALES.replace('command place() Draft -> Placed', 'command place() Draft -> Placed changes total, lines');
        const client = await start({ 'common.dt': COMMON, 'sales.dt': sales });
        expect(await client.until('sales.dt', () => true)).toEqual([]);
        const hover = await client.request<{ contents: { value: string } } | null>('textDocument/hover', 'sales.dt', at(sales, 'place'));
        expect(hover?.contents.value).toBe('**command `place`** — `Sales.Order:place`\n\n```dt\nchanges total, lines\n```\n\n```dt\nemits OrderPlaced\n```');
        type Symbol = { name: string; children?: Symbol[] };
        const symbols = await client.connection.sendRequest<Symbol[]>('textDocument/documentSymbol', { textDocument: { uri: client.uri('sales.dt') } });
        expect(symbols[0].children![1].children!.map((s) => s.name)).toEqual(['id', 'total', 'lines', 'Draft', 'Placed', 'positive', 'place']);
        // the names in `changes` are fields, which are not renamed (as in expressions)
        expect(await client.request('textDocument/prepareRename', 'sales.dt', at(sales, 'changes total', 'changes '.length))).toBeNull();
        const edit = await client.request<{ changes: Record<string, unknown[]> }>('textDocument/rename', 'sales.dt', at(sales, 'state Placed', 'state '.length), { newName: 'Ordered' });
        expect(edit.changes[client.uri('sales.dt')]).toHaveLength(2);
    });

    test('policies: hover, outline, and renaming the event or the command updates them', async () => {
        const billing = BILLING.replace('    state Open\n', '    state Open\n    create command issue(id: InvoiceId) -> Open\n').replace(
            '  id InvoiceId: UUID\n',
            '  id InvoiceId: UUID\n  /// Bill what is placed.\n  policy BillPlaced "請求する" when Sales.OrderPlaced -> Invoice.issue\n',
        );
        const client = await start({ 'common.dt': COMMON, 'sales.dt': SALES, 'billing.dt': billing });
        expect(await client.until('billing.dt', () => true)).toEqual([]);
        const hover = (file: string, pos: { line: number; character: number }) =>
            client.request<{ contents: { value: string } } | null>('textDocument/hover', file, pos).then((h) => h?.contents.value);
        expect(await hover('billing.dt', at(billing, 'BillPlaced'))).toBe(
            '**policy `BillPlaced`** 請求する — `Billing.BillPlaced`\n\nBill what is placed.\n\n```dt\nwhen Sales.OrderPlaced -> Invoice.issue\n```\n\nAfter the event, the command is run — eventually, by any mechanism.',
        );
        expect(await hover('billing.dt', at(billing, 'command issue', 'command '.length))).toBe('**create command `issue`** — `Billing.Invoice:issue`\n\nRun by policy `Billing.BillPlaced` (when Sales.OrderPlaced)');
        expect(await hover('sales.dt', at(SALES, 'event OrderPlaced', 'event '.length))).toBe('**event `OrderPlaced`** — `Sales.OrderPlaced`\n\nReacted to by policy `Billing.BillPlaced` (-> Invoice.issue)');

        type Symbol = { name: string; children?: Symbol[] };
        const symbols = await client.connection.sendRequest<Symbol[]>('textDocument/documentSymbol', { textDocument: { uri: client.uri('billing.dt') } });
        expect(symbols[0].children!.map((s) => s.name)).toEqual(['InvoiceId', 'BillPlaced', 'Invoice']);

        type Edits = { changes: Record<string, { range: { start: { line: number; character: number }; end: { character: number } }; newText: string }[]> };
        const renamed = (text: string, file: string, edit: Edits) => {
            const lines = text.split('\n');
            for (const e of [...(edit.changes[client.uri(file)] ?? [])].sort((a, b) => b.range.start.character - a.range.start.character)) {
                const l = lines[e.range.start.line];
                lines[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
            }
            return lines.join('\n');
        };
        // the command, from the policy and from its declaration
        const byPolicy = await client.request<Edits>('textDocument/rename', 'billing.dt', at(billing, 'Invoice.issue', 'Invoice.'.length), { newName: 'bill' });
        expect(renamed(billing, 'billing.dt', byPolicy)).toBe(billing.replace('Invoice.issue', 'Invoice.bill').replace('command issue', 'command bill'));
        const byCommand = await client.request<Edits>('textDocument/rename', 'billing.dt', at(billing, 'command issue', 'command '.length), { newName: 'bill' });
        expect(renamed(billing, 'billing.dt', byCommand)).toBe(billing.replace('Invoice.issue', 'Invoice.bill').replace('command issue', 'command bill'));
        // the event (qualified in the policy) and the aggregate
        const event = await client.request<Edits>('textDocument/rename', 'sales.dt', at(SALES, 'event OrderPlaced', 'event '.length), { newName: 'OrderSubmitted' });
        expect(renamed(billing, 'billing.dt', event)).toBe(billing.replace('Sales.OrderPlaced', 'Sales.OrderSubmitted'));
        const aggregate = await client.request<Edits>('textDocument/rename', 'billing.dt', at(billing, 'aggregate Invoice', 'aggregate '.length), { newName: 'Bill' });
        expect(renamed(billing, 'billing.dt', aggregate)).toBe(billing.replace('-> Invoice.issue', '-> Bill.issue').replace('aggregate Invoice', 'aggregate Bill'));
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

    test('loads the files dt check loads: those ignored by .gitignore are not', async () => {
        const dir = await workspace({ '.gitignore': 'copy/\n', 'common.dt': COMMON, 'sales.dt': SALES.replace('total: Money', 'total: Missing') });
        await Bun.write(path.join(dir, 'copy', 'common.dt'), COMMON);
        await Bun.write(path.join(dir, 'copy', 'sales.dt'), SALES);
        const client = await Client.start(dir);
        clients.push(client);
        const sales = await client.until('sales.dt', (d) => d.length > 0);
        expect(asCheckLines(sales)).toEqual(await checkOutput(dir, 'sales.dt'));
        expect(sales.map((d) => d.code)).toEqual(['M001']);
        expect(await client.until('common.dt', () => true)).toEqual([]);
        expect([...client.diagnostics.keys()].filter((f) => f.startsWith('copy'))).toEqual([]);
    });

    test('without a config file, the nearest config of an opened document becomes the workspace', async () => {
        const dir = await workspace({ 'other.dt': 'context {' });
        await Bun.write(path.join(dir, 'shop', 'domaintrail.jsonc'), JSON.stringify({ sources: ['model/**/*.dt'] }));
        await Bun.write(path.join(dir, 'shop', 'model', 'common.dt'), COMMON);
        const sales = SALES.replace('total: Money', 'total: Missing');
        await Bun.write(path.join(dir, 'shop', 'model', 'sales.dt'), sales);
        await Bun.write(path.join(dir, 'shop', 'scratch.dt'), 'context {');
        const client = await Client.start(dir);
        clients.push(client);
        // every .dt file below the workspace folder at first
        await client.until('other.dt', (d) => d.length > 0);
        await client.until(path.join('shop', 'scratch.dt'), (d) => d.length > 0);

        await client.open(path.join('shop', 'model', 'sales.dt'), sales);
        const expected = await checkOutput(path.join(dir, 'shop'), path.join('model', 'sales.dt'));
        const diagnostics = await client.until(path.join('shop', 'model', 'sales.dt'), (d) => asCheckLines(d).join() === expected.join());
        expect(diagnostics.map((d) => d.code)).toEqual(['M001']);
        // the files outside the shop's sources are cleared and no longer checked
        await client.until('other.dt', (d) => d.length === 0);
        await client.until(path.join('shop', 'scratch.dt'), (d) => d.length === 0);
        expect(await client.until(path.join('shop', 'model', 'common.dt'), (d) => d.length === 0)).toEqual([]);

        // an opened file outside the workspace gets no diagnostics
        await client.open('other.dt', 'context {');
        await client.open(path.join('shop', 'model', 'common.dt'), COMMON.replace('amount: Decimal', 'amount: Nope'));
        await client.until(path.join('shop', 'model', 'common.dt'), (d) => d.length > 0);
        expect(client.diagnostics.get('other.dt')).toEqual([]);
        expect(client.messages).toEqual([]);
    });

    test('a document under another config than the workspace one gets no diagnostics, and a warning once', async () => {
        const dir = await workspace({});
        for (const name of ['a', 'b']) {
            await Bun.write(path.join(dir, name, 'domaintrail.json'), '{}');
            await Bun.write(path.join(dir, name, 'sales.dt'), SALES.replace('total: Money', 'total: Missing'));
        }
        const client = await Client.start(dir);
        clients.push(client);
        await client.until(path.join('b', 'sales.dt'), (d) => d.length > 0);
        await client.open(path.join('a', 'sales.dt'), SALES.replace('total: Money', 'total: Missing'));
        await client.until(path.join('b', 'sales.dt'), (d) => d.length === 0);
        expect((await client.until(path.join('a', 'sales.dt'), (d) => d.length > 0)).map((d) => d.code)).toEqual(['M001']);

        await client.open(path.join('b', 'sales.dt'), 'context {');
        await client.connection.sendNotification('textDocument/didClose', { textDocument: { uri: client.uri(path.join('b', 'sales.dt')) } });
        await client.open(path.join('b', 'sales.dt'), 'context {');
        const deadline = Date.now() + 10_000;
        while (client.messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => setTimeout(resolve, 300)); // a second warning would have come by now
        expect(client.messages).toEqual([
            `${path.join(dir, 'b', 'sales.dt')} belongs to ${path.join(dir, 'b', 'domaintrail.json')}, not to the workspace of this session (${path.join(dir, 'a', 'domaintrail.json')}): its diagnostics are not computed. Open ${path.join(dir, 'b')} as its own project to check it.`,
        ]);
        expect(client.diagnostics.get(path.join('b', 'sales.dt'))).toEqual([]);
    });
});
