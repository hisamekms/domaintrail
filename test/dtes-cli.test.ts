import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { formatDomain } from '@domaintrail/modeling';
import { formatStorming } from '@domaintrail/storming';

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

/** A storming with one problem of each `.dt` rule: S011 (line 4), S010 (5), S012 (8), S013 (15). */
const FLOW = `storming Delivery "配送" {
  event ShipmentCancelled "配送キャンセル" { ref Delivery.ShipmentCancelled }
  event ShipmentDelivered { ref Delivery.ShipmentDelivered }
  event Lost { ref Delivery.Shipment }
  event Gone { ref ShipmentGone }
  aggregate Shipment { ref Delivery.Shipment }
  command Cancel {
    ref Delivery.Courier.assign
    handledBy Shipment
  }
  command Deliver {
    ref Delivery.Shipment.deliver
    handledBy Shipment
    by Courier
    emits ShipmentCancelled
  }
  actor Courier
  hotspot CancelOpen "誰が取り消す？" { on Cancel }
}
`;

const VALID = `storming Delivery {
  event ShipmentCancelled { ref Delivery.ShipmentCancelled }
  aggregate Shipment { ref Delivery.Shipment }
  actor Courier
  command Cancel {
    ref Delivery.Shipment.cancel
    by Courier
    handledBy Shipment
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

describe('dt check', () => {
    test('prints the .dtes diagnostics with the .dt ones and exits 1 on an error', async () => {
        const dir = await workspace({ 'domain.dt': DT, 'flow.dtes': FLOW });
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(1);
        expect(r.err).toContain("flow.dtes:5:16 - error S010: The event ref 'ShipmentGone' is not fully qualified: write 'Context.Event'.");
        expect(r.out.some((l) => l.startsWith('flow.dtes:15:5 - warning S013: '))).toBe(true);
        expect(r.err.at(-1)).toBe('2 file(s) checked: 2 error(s), 2 warning(s), 3 info(s).');
    });

    test('lists the gaps open hotspots keep open, and counts infos apart; neither changes the exit code', async () => {
        const dir = await workspace({
            'flow.dtes':
                'storming Delivery {\n  event Asked\n  event Done\n  command Cancel {\n    emits Done\n  }\n  hotspot Who "誰が？" {\n    on Cancel\n  }\n}\n',
        });
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(0);
        expect(r.out).toContain('1 element(s) incomplete under open hotspots: Delivery/Cancel.');
        expect(r.out.some((l) => l.startsWith('flow.dtes:2:9 - info S029: '))).toBe(true);
        expect(r.out.at(-1)).toBe('1 file(s) checked: 0 error(s), 0 warning(s), 1 info(s).');
        const json = await run('-r', dir, 'check', '--format', 'json');
        expect((JSON.parse(json.out.join('\n')) as { summary: object }).summary).toEqual({ files: 1, errors: 0, warnings: 0, infos: 1 });
    });

    test('exits 0 on warnings only, and on a workspace of .dtes files only', async () => {
        const warnings = await workspace({ 'domain.dt': DT, 'flow.dtes': FLOW.replace(/  event (Lost|Gone) .*\n/g, '') });
        const r = await run('-r', warnings, 'check');
        expect(r.code).toBe(0);
        expect(r.out.at(-1)).toBe('2 file(s) checked: 0 error(s), 2 warning(s), 1 info(s).');

        const only = await workspace({ 'flow.dtes': 'storming Delivery {\n  event ShipmentCancelled\n}\n' });
        expect((await run('-r', only, 'check')).out).toEqual(['1 file(s) checked: 0 error(s), 0 warning(s).']);
    });

    test('--format json carries both, with codes the schema accepts', async () => {
        const dir = await workspace({ 'domain.dt': DT.replace('command assign()', 'command assign() emits Missing'), 'flow.dtes': FLOW });
        const r = await run('-r', dir, 'check', '--format', 'json');
        expect(r.code).toBe(1);
        const report = JSON.parse(r.out.join('\n')) as { diagnostics: { file: string; line: number; code: string }[]; summary: object };
        expect(report.diagnostics.filter((d) => d.code !== 'S029').map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
            'domain.dt:16 M007',
            'flow.dtes:4 S011',
            'flow.dtes:5 S010',
            'flow.dtes:8 S012',
            'flow.dtes:15 S013',
        ]);
        expect(report.summary).toEqual({ files: 2, errors: 3, warnings: 2, infos: 3 });
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
        expect(report.diagnostics.filter((d) => d.code !== 'S029').map((d) => d.code)).toEqual(['S011', 'S010', 'S012', 'S013']);
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
