import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';

// The example workspaces of the Event Storming guide (site/examples: one per phase of the workshop, its figures drawn
// from them) stay valid and formatted as the language changes (site/scripts/check-examples.ts checks the same).
const EXAMPLES = path.join(import.meta.dir, '..', 'site', 'examples');
const PHASES = ['events', 'flows', 'exceptions', 'questions', 'design'];

async function dt(args: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => out.push(l) }, cliDeps());
    return { code, out: out.join('\n') };
}

describe('the guide site examples', () => {
    test('one workspace per phase', () => {
        const dirs = readdirSync(EXAMPLES, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        expect(dirs.sort()).toEqual([...PHASES].sort());
    });
    for (const phase of PHASES)
        test(`${phase}: dt check without warnings, formatted`, async () => {
            const root = path.join(EXAMPLES, phase);
            const check = await dt(['-r', root, 'check']);
            expect(check.code).toBe(0);
            expect(check.out).toContain('0 error(s), 0 warning(s)');
            expect((await dt(['-r', root, 'fmt', '--check'])).code).toBe(0);
        });
});
