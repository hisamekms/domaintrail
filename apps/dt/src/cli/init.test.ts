import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps } from '../main.js';
import { runCli } from './main.js';

const roots: string[] = [];
const workspace = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-init-'));
    roots.push(root);
    return root;
};
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function run(root: string, ...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['-r', root, 'init', '--format', 'json', ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, cliDeps());
    return { code, plan: JSON.parse(out.join('\n')) as Record<string, unknown>, err: err.join('\n') };
}

describe('AI-first init', () => {
    test('plans without writing, then creates a coherent config once', async () => {
        const root = await workspace();
        const before = await run(root);
        expect(before.code).toBe(0);
        expect(before.plan).toMatchObject({
            version: 1,
            status: 'ready',
            applied: false,
            layout: { sources: ['model/**/*.dt', 'stormings/**/*.dtes'], generatedTs: 'generated/domain' },
            evidence: { sources: [], packages: [] },
        });
        expect(before.plan.changes).toHaveLength(1);
        const applied = await run(root, '--apply');
        expect(applied.code).toBe(0);
        expect(applied.plan.applied).toBe(true);
        const config = await readFile(path.join(root, 'domaintrail.jsonc'), 'utf8');
        expect(JSON.parse(config)).toMatchObject({
            sources: ['model/**/*.dt', 'stormings/**/*.dtes'],
            generate: { ts: { out: 'generated/domain' } },
            knowledge: { store: 'files' },
        });
        const again = await run(root, '--apply');
        expect(again.code).toBe(0);
        expect(again.plan).toMatchObject({ status: 'existing', applied: false, changes: [] });
        expect(await readFile(path.join(root, 'domaintrail.jsonc'), 'utf8')).toBe(config);
    });

    test('keeps an existing config authoritative', async () => {
        const root = await workspace();
        const config =
            '{"sources":["domain/**/*.dt"],"generate":{"ts":{"out":"src/generated","contexts":{"Common":{"out":"packages/shared/src/generated","module":"@acme/shared"}}}}}\n';
        await writeFile(path.join(root, 'domaintrail.jsonc'), config);
        const result = await run(root, '--apply');
        expect(result.plan).toMatchObject({
            status: 'existing',
            applied: false,
            layout: {
                sources: ['domain/**/*.dt'],
                generatedTs: 'src/generated',
                contextOutputs: { Common: { out: 'packages/shared/src/generated', module: '@acme/shared' } },
            },
        });
        expect(await readFile(path.join(root, 'domaintrail.jsonc'), 'utf8')).toBe(config);
    });

    test('does not create a project config over an existing local-only config', async () => {
        const root = await workspace();
        await writeFile(path.join(root, 'domaintrail.local.jsonc'), '{"sources":["legacy/**/*.dt"]}\n');
        const result = await run(root, '--apply');
        expect(result.plan).toMatchObject({
            status: 'existing',
            evidence: { localConfig: 'domaintrail.local.jsonc' },
            layout: { sources: ['legacy/**/*.dt'] },
            changes: [],
        });
    });

    test('reports an invalid existing config as JSON without changing it', async () => {
        const root = await workspace();
        await writeFile(path.join(root, 'domaintrail.jsonc'), '{"sources": "wrong"}\n');
        const result = await run(root, '--apply');
        expect(result.code).toBe(2);
        expect(result.plan.error).toContain("'sources' must be an array of glob strings");
        expect(result.err).toBe('');
    });

    test('does not hide existing model files with narrower source globs', async () => {
        const root = await workspace();
        await mkdir(path.join(root, 'legacy'));
        await writeFile(path.join(root, 'legacy', 'order.dt'), 'context Sales {}\n');
        const result = await run(root, '--apply');
        expect(result.code).toBe(1);
        expect(result.plan).toMatchObject({
            status: 'needs_decision',
            evidence: { sources: ['legacy/order.dt'] },
            layout: { sources: ['**/*.dt', '**/*.dtes'], recommendedSources: ['model/**/*.dt', 'stormings/**/*.dtes'] },
            changes: [],
        });
    });

    test('asks for package ownership in a one-product monorepo', async () => {
        const root = await workspace();
        for (const name of ['api', 'web']) {
            await mkdir(path.join(root, 'packages', name), { recursive: true });
            await writeFile(path.join(root, 'packages', name, 'package.json'), '{}\n');
        }
        const result = await run(root, '--apply');
        expect(result.code).toBe(1);
        expect(result.plan).toMatchObject({
            status: 'needs_decision',
            evidence: { packages: ['packages/api/package.json', 'packages/web/package.json'] },
            layout: { generatedTs: 'undecided (choose owning package)' },
        });
        expect((result.plan.decisions as string[]).join(' ')).toContain('generated TypeScript owner');
    });

    test('one nested package beside a root package also needs an output owner', async () => {
        const root = await workspace();
        await writeFile(path.join(root, 'package.json'), '{}\n');
        await mkdir(path.join(root, 'packages', 'api'), { recursive: true });
        await writeFile(path.join(root, 'packages', 'api', 'package.json'), '{}\n');
        const result = await run(root, '--apply');
        expect(result.plan).toMatchObject({ status: 'needs_decision', layout: { generatedTs: 'undecided (choose owning package)' } });
    });

    test('reports independent nested workspaces as unsupported at the repository root', async () => {
        const root = await workspace();
        for (const name of ['shop', 'billing']) {
            await mkdir(path.join(root, 'apps', name), { recursive: true });
            await writeFile(path.join(root, 'apps', name, 'domaintrail.jsonc'), '{}\n');
        }
        const result = await run(root, '--apply');
        expect(result.code).toBe(1);
        expect(result.plan).toMatchObject({
            status: 'unsupported',
            evidence: { nestedConfigs: ['apps/billing/domaintrail.jsonc', 'apps/shop/domaintrail.jsonc'] },
        });
    });

    test('does not create a nested config under a parent workspace', async () => {
        const root = await workspace();
        await writeFile(path.join(root, 'domaintrail.jsonc'), '{}\n');
        const child = path.join(root, 'packages', 'api');
        await mkdir(child, { recursive: true });
        const result = await run(child, '--apply');
        expect(result.code).toBe(1);
        expect(result.plan).toMatchObject({
            status: 'needs_decision',
            layout: { model: 'existing paths (see sources and evidence)' },
            changes: [],
        });
    });

    test('an explicit -c selects the config directory instead of the -r directory', async () => {
        const root = await workspace();
        const configRoot = path.join(root, 'config');
        await mkdir(configRoot);
        await writeFile(path.join(configRoot, 'domaintrail.jsonc'), '{"sources":["model/**/*.dt"]}\n');
        const out: string[] = [];
        const code = await runCli(
            ['-r', root, '-c', path.join(configRoot, 'domaintrail.jsonc'), 'init', '--apply', '--format', 'json'],
            { out: (s) => out.push(s), err: () => undefined },
            cliDeps(),
        );
        const plan = JSON.parse(out.join('\n')) as Record<string, unknown>;
        expect(code).toBe(0);
        expect(plan).toMatchObject({ root: configRoot, status: 'existing', changes: [], layout: { sources: ['model/**/*.dt'] } });
    });

    test('an apply race returns one JSON decision instead of overwriting the new config', async () => {
        const root = await workspace();
        const base = cliDeps();
        const deps = {
            ...base,
            findDomainFiles: async (...args: Parameters<typeof base.findDomainFiles>) => {
                await writeFile(path.join(root, 'domaintrail.jsonc'), '{"sources":["legacy/**/*.dt"]}\n');
                return base.findDomainFiles(...args);
            },
        };
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(['-r', root, 'init', '--apply', '--format', 'json'], { out: (s) => out.push(s), err: (s) => err.push(s) }, deps);
        const plan = JSON.parse(out.join('\n')) as Record<string, unknown>;
        expect(code).toBe(1);
        expect(err).toEqual([]);
        expect(plan).toMatchObject({ status: 'needs_decision', applied: false, changes: [] });
        expect(await readFile(path.join(root, 'domaintrail.jsonc'), 'utf8')).toBe('{"sources":["legacy/**/*.dt"]}\n');
    });
});
