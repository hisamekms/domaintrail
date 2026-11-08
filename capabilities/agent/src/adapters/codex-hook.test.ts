import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { codexHookSource, type CodexHookRole } from './codex-hook.js';

test('Codex Hook permits role tools and rejects shell, non-DSL edits, and path escapes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dt-codex-hook-test-'));
    const policy = path.join(root, 'policy.cjs');
    const outside = mkdtempSync(path.join(tmpdir(), 'dt-codex-hook-outside-'));
    try {
        writeFileSync(path.join(root, 'model.dt'), 'context Example {}\n');
        symlinkSync(outside, path.join(root, 'link'));
        writeFileSync(path.join(outside, 'reference.txt'), 'approved context\n');
        writeFileSync(path.join(outside, "reader's-notes.txt"), 'other context\n');
        const allowed = (role: CodexHookRole, tool_name: string, command: string, extras: readonly string[] = []): boolean => {
            writeFileSync(policy, codexHookSource(root, role, extras));
            const result = spawnSync(process.execPath, [policy], {
                input: JSON.stringify({ tool_name, tool_input: { command } }),
                encoding: 'utf8',
            });
            expect(result.status).toBe(0);
            if (!result.stdout) return true;
            expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
            return false;
        };
        expect(allowed('run', 'Bash', "rg --files -g '*.dt' -g '*.dtes'")).toBe(true);
        expect(allowed('run', 'Bash', "rg -n '^' -- 'model.dt'")).toBe(true);
        expect(allowed('run', 'Bash', "rg -n '^' -- model.dt")).toBe(true);
        expect(allowed('run', 'Bash', "rg -n '^' -- 'policy.cjs'")).toBe(false);
        expect(allowed('run', 'Bash', "rg -n '^' -- model.dt; echo unsafe")).toBe(false);
        expect(allowed('run', 'Bash', 'dt check')).toBe(true);
        expect(allowed('run', 'Bash', 'dt check --storming-level=design-level')).toBe(true);
        expect(allowed('run', 'Bash', 'dt check --storming-level=design-level --storming Orders --timeline Normal')).toBe(true);
        expect(allowed('run', 'Bash', 'dt check --storming-level=design-level --timeline Normal')).toBe(false);
        expect(allowed('run', 'Bash', 'dt check --storming-level=design-level; echo unsafe')).toBe(false);
        expect(allowed('run', 'Bash', 'echo unsafe')).toBe(false);
        expect(allowed('run', 'apply_patch', '*** Begin Patch\n*** Update File: model.dt\n@@\n-old\n+new\n*** End Patch')).toBe(true);
        expect(
            allowed('run', 'apply_patch', `*** Begin Patch\n*** Update File: ${path.join(realpathSync(root), 'model.dt')}\n@@\n-old\n+new\n*** End Patch`),
        ).toBe(true);
        expect(allowed('run', 'apply_patch', '*** Begin Patch\n*** Add File: script.ts\n+bad\n*** End Patch')).toBe(false);
        expect(allowed('run', 'apply_patch', '*** Begin Patch\n*** Add File: ../escape.dt\n+bad\n*** End Patch')).toBe(false);
        expect(allowed('run', 'apply_patch', '*** Begin Patch\n*** Add File: link/escape.dt\n+bad\n*** End Patch')).toBe(false);
        expect(allowed('read', 'Bash', 'rg --files')).toBe(true);
        expect(allowed('read', 'Bash', "rg -n '^' -- 'model.dt'")).toBe(true);
        expect(allowed('read', 'apply_patch', '*** Begin Patch\n*** Update File: model.dt\n@@\n-old\n+new\n*** End Patch')).toBe(false);
        expect(allowed('run', 'Bash', `rg --files --hidden '${outside}'`, [outside])).toBe(true);
        expect(allowed('read', 'Bash', `rg -n '^' -- '${path.join(outside, 'reference.txt')}'`, [outside])).toBe(true);
        expect(allowed('read', 'Bash', `rg -n '^' -- '${path.join(outside, 'reader')}'\\''s-notes.txt'`, [outside])).toBe(true);
        expect(allowed('run', 'Bash', `rg -n '^' -- '${path.join(outside, 'reference.txt')}'`, [outside])).toBe(true);
        expect(
            allowed('run', 'apply_patch', `*** Begin Patch\n*** Update File: ${path.join(outside, 'reference.txt')}\n@@\n-old\n+new\n*** End Patch`, [outside]),
        ).toBe(false);
        expect(allowed('none', 'Bash', 'rg --files')).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    }
});
