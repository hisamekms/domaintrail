import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps } from '../src/composition/cli.js';
import { runCli } from '../src/presentation/cli/main.js';
import { formatStorming } from '../src/modeling/storming/format.js';
import { formatDomain } from '../src/modeling/format/format.js';
import { check } from './helpers.js';

const DT = `context Delivery {
  id ShipmentId: UUID
  id CourierId: UUID
  event ShipmentCancelled { shipmentId: ShipmentId }
  event ShipmentDelivered { shipmentId: ShipmentId }
  aggregate Shipment {
    id: ShipmentId
    state Pending
    state Delivered
    state Cancelled
    command cancel() Pending -> Cancelled emits ShipmentCancelled
    command deliver() Pending -> Delivered emits ShipmentDelivered
  }
  aggregate Courier {
    id: CourierId
    command assign()
  }
}
`;

/** A storming with one problem of each `.dt` rule: S011 (line 4), S010 (5), S012 (8), S013 (14). */
const FLOW = `storming Delivery "配送" {
  event ShipmentCancelled "配送キャンセル" { ref Delivery.ShipmentCancelled }
  event ShipmentDelivered { ref Delivery.ShipmentDelivered }
  event Lost { ref Delivery.Shipment }
  event Gone { ref ShipmentGone }
  aggregate Shipment { ref Delivery.Shipment }
  command Cancel {
    ref Delivery.Courier.assign
    target Shipment
  }
  command Deliver {
    ref Delivery.Shipment.deliver
    target Shipment
    emits ShipmentCancelled
  }
}
`;

const VALID = `storming Delivery {
  event ShipmentCancelled { ref Delivery.ShipmentCancelled }
  aggregate Shipment { ref Delivery.Shipment }
  command Cancel {
    ref Delivery.Shipment.cancel
    target Shipment
    emits ShipmentCancelled
  }
  timeline Main { ShipmentCancelled }
}
`;

const UNFORMATTED = `storming Delivery {
    event ShipmentCancelled {}
  command Cancel { emits ShipmentCancelled }
}
`;

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dtes-'));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
    }
    return dir;
}

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
    return { code, out, err };
}

const where = (d: { file: string; start: { line: number }; code: string }) => `${d.file}:${d.start.line} ${d.code}`;

describe('analyze with .dtes sources', () => {
    test('reports S010–S013 at their file and line, merged with the .dt diagnostics', async () => {
        const a = await check({ 'domain.dt': DT, 'flow.dtes': FLOW });
        expect(a.diagnostics.map(where)).toEqual(['flow.dtes:4 S011', 'flow.dtes:5 S010', 'flow.dtes:8 S012', 'flow.dtes:14 S013']);
        expect(a.ok).toBe(false);
        expect(a.syntaxOk).toBe(true);
        expect(a.files).toEqual(['domain.dt', 'flow.dtes']);
        expect(a.documents).toHaveLength(1);
        expect(a.stormings).toMatchObject({
            files: ['flow.dtes'],
            syntaxOk: true,
            stormings: [{ id: 'Delivery', label: '配送', range: { file: 'flow.dtes' } }],
        });
        expect(a.stormings.diagnostics).toEqual(a.diagnostics);
        expect(a.diagnostics.find((d) => d.code === 'S013')?.elementId).toBe('es/Delivery/Deliver');
    });

    test('a broken .dtes does not hide the model, and a valid one makes the workspace ok', async () => {
        const broken = await check({ 'domain.dt': DT, 'flow.dtes': 'storming Delivery {\n  event\n' });
        expect(broken.diagnostics.map(where)).toEqual(['flow.dtes:2 SYNTAX']);
        expect(broken.syntaxOk).toBe(true);
        expect(broken.model?.elements['Delivery.Shipment']).toBeDefined();
        expect(broken.stormings).toMatchObject({ syntaxOk: false, stormings: [] });
        expect(broken.ok).toBe(false);

        const valid = await check({ 'domain.dt': DT, 'flow.dtes': VALID });
        expect(valid.diagnostics).toEqual([]);
        expect(valid.ok).toBe(true);
    });

    test('without a .dt model the refs are not checked, the local rules are', async () => {
        const a = await check({ 'domain.dt': 'context Delivery {', 'flow.dtes': FLOW.replace('target Shipment', 'target Gone') });
        expect(a.model).toBeUndefined();
        expect(a.diagnostics.map(where)).toEqual(['domain.dt:1 SYNTAX', 'flow.dtes:9 S003']);
    });

    test('a workspace of .dtes files only is valid', async () => {
        const a = await check({ 'flow.dtes': VALID.replace(/ \{ ref [\w.]+ \}/g, '').replace(/    ref [\w.]+\n/, '') });
        expect(a.diagnostics).toEqual([]);
        expect(a.ok).toBe(true);
    });
});

describe('dt check', () => {
    test('prints the .dtes diagnostics with the .dt ones and exits 1 on an error', async () => {
        const dir = await workspace({ 'domain.dt': DT, 'flow.dtes': FLOW });
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(1);
        expect(r.err).toContain("flow.dtes:5:16 - error S010: The event ref 'ShipmentGone' is not fully qualified: write 'Context.Event'.");
        expect(r.out.some((l) => l.startsWith('flow.dtes:14:5 - warning S013: '))).toBe(true);
        expect(r.err.at(-1)).toBe('2 file(s) checked: 2 error(s), 2 warning(s).');
    });

    test('exits 0 on warnings only, and on a workspace of .dtes files only', async () => {
        const warnings = await workspace({ 'domain.dt': DT, 'flow.dtes': FLOW.replace(/  event (Lost|Gone) .*\n/g, '') });
        const r = await run('-r', warnings, 'check');
        expect(r.code).toBe(0);
        expect(r.out.at(-1)).toBe('2 file(s) checked: 0 error(s), 2 warning(s).');

        const only = await workspace({ 'flow.dtes': 'storming Delivery {\n  event ShipmentCancelled\n}\n' });
        expect((await run('-r', only, 'check')).out).toEqual(['1 file(s) checked: 0 error(s), 0 warning(s).']);
    });

    test('--format json carries both, with codes the schema accepts', async () => {
        const dir = await workspace({ 'domain.dt': DT.replace('command assign()', 'command assign() emits Missing'), 'flow.dtes': FLOW });
        const r = await run('-r', dir, 'check', '--format', 'json');
        expect(r.code).toBe(1);
        const report = JSON.parse(r.out.join('\n')) as { diagnostics: { file: string; line: number; code: string }[]; summary: object };
        expect(report.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
            'domain.dt:16 M007',
            'flow.dtes:4 S011',
            'flow.dtes:5 S010',
            'flow.dtes:8 S012',
            'flow.dtes:14 S013',
        ]);
        expect(report.summary).toEqual({ files: 2, errors: 3, warnings: 2 });
        const schema = JSON.parse(await readFile(path.join(import.meta.dir, '..', 'schema', 'diagnostics.schema.json'), 'utf8'));
        const pattern = new RegExp(schema.definitions.diagnostic.properties.code.pattern);
        for (const d of report.diagnostics) expect(d.code).toMatch(pattern);
    });

    test('finds .dtes files by the sources and .gitignore, like .dt files', async () => {
        const dir = await workspace({
            '.gitignore': 'drafts/\n',
            'domain.dt': DT,
            'drafts/broken.dtes': 'storming {',
            'model/flow.dtes': FLOW,
        });
        const r = await run('-r', dir, 'check', '--format', 'json');
        const files = (JSON.parse(r.out.join('\n')) as { diagnostics: { file: string }[] }).diagnostics.map((d) => d.file);
        expect(new Set(files)).toEqual(new Set([path.join('model', 'flow.dtes')]));

        // a config that lists its sources sees .dtes files only through a glob of its own
        await writeFile(path.join(dir, 'domaintrail.jsonc'), JSON.stringify({ sources: ['**/*.dt'] }));
        expect((await run('-r', dir, 'check')).out).toEqual(['1 file(s) checked: 0 error(s), 0 warning(s).']);
    });

    test('says that neither .dt nor .dtes files were found', async () => {
        const dir = await workspace({});
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(1);
        expect(r.err).toEqual([`No .dt or .dtes files found under ${dir} (sources: **/*.dt, **/*.dtes).`]);
    });
});

describe('dt fmt', () => {
    test('formats .dtes files with their own layout, and --check lists them', async () => {
        const dir = await workspace({ 'domain.dt': formatDomain(DT), 'flow.dtes': UNFORMATTED });
        const checked = await run('-r', dir, 'fmt', '--check');
        expect(checked.code).toBe(1);
        expect(checked.out).toEqual(['flow.dtes']);
        expect(await readFile(path.join(dir, 'flow.dtes'), 'utf8')).toBe(UNFORMATTED);

        const r = await run('-r', dir, 'fmt');
        expect(r.code).toBe(0);
        expect(r.out).toEqual(['flow.dtes', '2 file(s): 1 formatted.']);
        const formatted = await readFile(path.join(dir, 'flow.dtes'), 'utf8');
        expect(formatted).toBe(formatStorming(UNFORMATTED));
        expect(formatted).toBe('storming Delivery {\n  event ShipmentCancelled\n  command Cancel {\n    emits ShipmentCancelled\n  }\n}\n');
        expect((await run('-r', dir, 'fmt', '--check')).code).toBe(0);
    });

    test('leaves a .dtes file with syntax errors alone, also when named', async () => {
        const dir = await workspace({ 'flow.dtes': 'storming Delivery {\n    event\n' });
        const r = await run('-r', dir, 'fmt');
        expect(r.code).toBe(1);
        expect(r.err.at(-1)).toBe('1 file(s): 0 formatted, 1 not formatted because of syntax errors.');
        expect(r.err[0]).toStartWith('flow.dtes:2:10 - error SYNTAX: ');

        const named = await workspace({ 'flow.dtes': UNFORMATTED });
        const cwd = process.cwd();
        process.chdir(named);
        try {
            expect((await run('fmt', 'flow.dtes')).code).toBe(0);
        } finally {
            process.chdir(cwd);
        }
        expect(await readFile(path.join(named, 'flow.dtes'), 'utf8')).toBe(formatStorming(UNFORMATTED));
    });
});

describe('dt generate ts', () => {
    test('is not blocked by .dtes errors, which it reports', async () => {
        const dir = await workspace({ 'domain.dt': DT, 'flow.dtes': FLOW });
        const r = await run('-r', dir, 'generate', 'ts', '--format', 'json');
        expect(r.code).toBe(0);
        const report = JSON.parse(r.out.join('\n')) as { diagnostics: { code: string }[]; written: string[] };
        expect(report.diagnostics.map((d) => d.code)).toEqual(['S011', 'S010', 'S012', 'S013']);
        expect(report.written).toHaveLength(1);
    });

    test('is blocked by .dt errors, and needs a .dt file', async () => {
        const broken = await workspace({ 'domain.dt': DT.replace('command assign()', 'command assign() emits Missing'), 'flow.dtes': VALID });
        const r = await run('-r', broken, 'generate', 'ts');
        expect(r.code).toBe(1);
        expect(r.err.at(-1)).toBe('Generation skipped because the model has errors.');

        const only = await workspace({ 'flow.dtes': 'storming Delivery {\n  event ShipmentCancelled\n}\n' });
        const o = await run('-r', only, 'generate', 'ts');
        expect(o.code).toBe(1);
        expect(o.err.at(-1)).toBe(`Generation skipped: no .dt files found under ${only} (sources: **/*.dt, **/*.dtes).`);
    });
});

describe('dt show', () => {
    test('reads the .dt files only', async () => {
        const dir = await workspace({ 'domain.dt': DT, 'flow.dtes': FLOW });
        const r = await run('-r', dir, 'show', 'Delivery.Shipment');
        expect(r.code).toBe(0);
        expect(r.err).toEqual([]);

        const only = await workspace({ 'flow.dtes': VALID });
        expect((await run('-r', only, 'show')).err).toEqual([`No .dt files found under ${only} (sources: **/*.dt, **/*.dtes).`]);
    });
});
