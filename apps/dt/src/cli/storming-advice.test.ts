import { describe, expect, test } from 'bun:test';
import { analyze } from '@domaintrail/analysis';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps } from '../main.js';
import { runCli } from './main.js';
import { designLevelAdvice } from './storming-advice.js';

const advice = async (source: string, scope?: { storming?: string; timeline?: string }) => {
    const analysis = await analyze([{ path: 'flow.dtes', text: source }]);
    expect(analysis.stormings.syntaxOk).toBe(true);
    return designLevelAdvice(analysis.stormings.stormings, scope);
};

const bp = `storming S {
  event A "A happened"
  event B "B happened"
  event C "C happened"
  timeline Main { A B C }
  timeline Repeat { A B }
}`;

describe('explicit Design Level advice', () => {
    test('finds a question before any command exists; duplicate pairs and scope are bounded', async () => {
        expect((await advice(bp)).map((d) => [d.code, d.severity, d.message.includes('Timeline order alone')])).toEqual([
            ['S034', 'info', true],
            ['S034', 'info', true],
        ]);
        expect(await advice(bp, { storming: 'Elsewhere' })).toEqual([]);
        expect((await advice(bp, { storming: 'S', timeline: 'Repeat' })).map((d) => d.elementId)).toEqual(['es/S/B']);
    });

    test('an unrelated event hotspot does not suppress advice, while a stated origin does', async () => {
        const withHotspot = bp.replace('  timeline Main', '  hotspot Price "What is the price?" { on A }\n  timeline Main');
        expect(await advice(withHotspot)).toHaveLength(2);
        const withOrigin = bp.replace(
            '  timeline Main',
            `  actor Clerk
  aggregate Order
  external Carrier
  command Approve { by Clerk handledBy Order emits B }
  event D { from Carrier }
  timeline Main`,
        );
        expect((await advice(withOrigin)).map((d) => d.elementId)).toEqual(['es/S/C']);
    });

    test('CLI flag adds info to text and JSON without changing the exit code or ordinary check', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dl-advice-'));
        try {
            await writeFile(path.join(dir, 'flow.dtes'), bp);
            const run = async (...args: string[]) => {
                const out: string[] = [];
                const err: string[] = [];
                const code = await runCli(['-r', dir, 'check', ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, cliDeps());
                return { code, out: out.join('\n'), err: err.join('\n') };
            };
            const ordinary = await run('--format', 'json');
            const scoped = await run('--storming-level=design-level', '--storming', 'S', '--timeline', 'Main', '--format', 'json');
            const text = await run('--storming-level=design-level', '--storming', 'S', '--timeline', 'Main');
            expect(ordinary.code).toBe(0);
            expect(JSON.parse(ordinary.out).diagnostics).toEqual([]);
            expect(scoped.code).toBe(0);
            expect(JSON.parse(scoped.out).diagnostics).toHaveLength(2);
            expect(JSON.parse(scoped.out).diagnostics[0]).toMatchObject({ code: 'S034', severity: 'info' });
            expect(text.code).toBe(0);
            expect(text.out).toContain('info S034');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
