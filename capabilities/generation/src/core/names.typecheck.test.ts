// Keywords as names (fields, parameters, commands, enum values, variants): the generated TypeScript type-checks.
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check } from '../test-helpers.js';

const MODEL = `context Model {
  enum BinaryOp { implies or and eq not in true false String state command }
  union TypeExpr {
    primitive { name: String }
    ref { ref: String  target: String? }
  }
  value Use {
    context: String
    event: String?
    errors: String[0..*]
    op: BinaryOp
    type: TypeExpr
    invariant k { op != BinaryOp.and implies exists(event) }
    invariant p { type.kind == TypeExpr.primitive or count(errors) > 0 }
  }
  id GId: UUID
  aggregate G {
    id: GId
    event: String
    state S
    create command command(id: GId, event: String, error: String) -> S
    command emits(errors: Int) S -> S
      requires few { errors < 3 } else TooMany
  }
  error TooMany
}
`;

describe('keywords as names', () => {
    test('check without diagnostics, and the generated TypeScript type-checks', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-names-'));
        try {
            const a = await check({ 'model.dt': MODEL });
            expect(a.diagnostics).toEqual([]);
            await mkdir(path.join(dir, 'gen'));
            for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'gen', f.path), f.content);
            await writeFile(
                path.join(dir, 'use.ts'),
                `import { Model } from './gen/index.js';
export const op: Model.BinaryOp = 'and';
export const use: Model.Use = { context: 'c', errors: [], op: 'state', type: { kind: 'primitive', name: 'x' } };
export const violated: readonly string[] = Model.checkUse(use);
`,
            );
            const tsc = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
            const r = Bun.spawnSync([tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'use.ts'], {
                cwd: dir,
            });
            expect(r.stdout.toString() + r.stderr.toString()).toBe('');
            expect(r.exitCode).toBe(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
