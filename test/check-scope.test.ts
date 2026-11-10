import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';

const DT = 'context Billing {\n  id InvoiceId: UUID\n}\n';
const DTES = 'storming Issue {\n  event Requested\n}\n';
const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-check-scope-'));
    roots.push(root);
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    }
    return root;
}

async function check(root: string, ...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['-r', root, 'check', ...args], { out: (line) => out.push(line), err: (line) => err.push(line) }, cliDeps());
    return { code, out, err };
}

describe('dt check focus options', () => {
    test('--no-knowledge skips K diagnostics while keeping journey diagnostics', async () => {
        const root = await workspace({
            'domain.dt': DT,
            'flow.dtes': DTES,
            'domaintrail.journey.json': '{bad',
            'knowledge/kn_00000001.md': 'bad',
        });
        const all = await check(root);
        expect(all.code).toBe(1);
        expect(all.err.join('\n')).toContain('J001');
        expect(all.err.join('\n')).toContain('K001');

        const focused = await check(root, '--no-knowledge', '--format', 'json');
        expect(focused.code).toBe(1);
        expect(focused.err).toEqual([]);
        const report = JSON.parse(focused.out.join('\n')) as { diagnostics: { code: string }[]; summary: { files: number; errors: number } };
        expect(report.diagnostics.map((d) => d.code)).toContain('J001');
        expect(report.diagnostics.map((d) => d.code)).not.toContain('K001');
        expect(report.summary.files).toBe(2);
    });

    test('--no-knowledge retains storming diagnostics', async () => {
        const root = await workspace({
            'domain.dt': DT,
            'flow.dtes': 'storming Issue {\n  event Requested { ref Billing.Gone }\n}\n',
            'knowledge/kn_00000001.md': 'bad',
        });
        const result = await check(root, '--no-knowledge', '--format', 'json');
        expect(result.code).toBe(1);
        const report = JSON.parse(result.out.join('\n')) as { diagnostics: { code: string }[] };
        expect(report.diagnostics.map((d) => d.code)).toContain('S010');
        expect(report.diagnostics.map((d) => d.code)).not.toContain('K001');
    });

    test('--scope dtes uses the model for ref linking and reports only storming diagnostics', async () => {
        const root = await workspace({
            'domain.dt': DT,
            'flow.dtes': 'storming Issue {\n  event Requested { ref Billing.Gone }\n}\n',
            'domaintrail.journey.json': '{bad',
            'knowledge/kn_00000001.md': 'bad',
        });
        const result = await check(root, '--scope', 'dtes', '--no-knowledge', '--format', 'json');
        expect(result.code).toBe(1);
        const report = JSON.parse(result.out.join('\n')) as { diagnostics: { code: string }[]; summary: { files: number; errors: number } };
        expect(report.diagnostics.map((d) => d.code)).toContain('S010');
        expect(report.diagnostics.every((d) => d.code.startsWith('S'))).toBe(true);
        expect(report.summary.files).toBe(1);
        expect(report.summary.errors).toBeGreaterThan(0);
    });

    test('--scope dtes fails clearly when .dt syntax prevents ref checks', async () => {
        const root = await workspace({ 'domain.dt': 'context Billing {', 'flow.dtes': 'storming Issue {\n  event Requested { ref Billing.Gone }\n}\n' });
        const text = await check(root, '--scope', 'dtes');
        expect(text.code).toBe(1);
        expect(text.err.join('\n')).toContain('ref check is incomplete');
        expect(text.err.join('\n')).toContain('1 file(s) checked:');
        expect([...text.out, ...text.err].join('\n')).not.toContain('domain.dt:');

        const json = await check(root, '--scope', 'dtes', '--format', 'json');
        expect(json.code).toBe(1);
        const report = JSON.parse(json.out.join('\n')) as { error: string; summary: { files: number }; diagnostics: { code: string }[] };
        expect(report.error).toContain('ref check is incomplete');
        expect(report.summary.files).toBe(1);
        expect(report.diagnostics.every((d) => d.code.startsWith('S'))).toBe(true);
    });

    test('--scope dtes succeeds with a valid model ref and unrelated knowledge errors', async () => {
        const root = await workspace({
            'domain.dt': 'context Billing {\n  event Requested { invoiceId: UUID }\n}\n',
            'flow.dtes': 'storming Issue {\n  event Requested { ref Billing.Requested }\n}\n',
            'knowledge/kn_00000001.md': 'bad',
        });
        const result = await check(root, '--scope', 'dtes', '--format', 'json');
        expect(result.code).toBe(0);
        const report = JSON.parse(result.out.join('\n')) as { diagnostics: { code: string }[]; summary: { files: number } };
        expect(report.diagnostics.some((d) => d.code === 'S010' || d.code === 'K001')).toBe(false);
        expect(report.summary.files).toBe(1);
    });

    test('--scope dtes fails when there are only .dt files', async () => {
        const root = await workspace({ 'domain.dt': DT });
        const result = await check(root, '--scope', 'dtes', '--format', 'json');
        expect(result.code).toBe(1);
        const report = JSON.parse(result.out.join('\n')) as { error: string; summary: { files: number } };
        expect(report.error).toContain('No .dtes files found');
        expect(report.summary.files).toBe(0);
    });

    test('generation gate is incompatible with dtes scope, and design-level advice remains available', async () => {
        const root = await workspace({ 'flow.dtes': DTES });
        const invalid = await check(root, '--scope', 'dtes', '--for-generation', '--format', 'json');
        expect(invalid.code).toBe(2);
        expect(JSON.parse(invalid.out.join('\n'))).toEqual({ error: '--for-generation cannot be combined with --scope dtes.' });

        const advice = await check(root, '--scope', 'dtes', '--storming-level', 'design-level', '--format', 'json');
        expect(advice.code).toBe(0);
        expect((JSON.parse(advice.out.join('\n')) as { summary: { files: number } }).summary.files).toBe(1);
    });
});
