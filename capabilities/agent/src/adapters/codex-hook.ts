// A Codex PreToolUse guard for dt's three roles. The script is generated outside the workspace and checked before
// each turn. The workspace cannot replace it. Codex hooks are a guardrail; the sandbox and post-run scan still apply.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export type CodexHookRole = 'run' | 'read' | 'none';

/** The policy script only receives fixed values dt wrote; it never evaluates workspace text. */
export function codexHookSource(root: string, role: CodexHookRole): string {
    return `
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync.native(${JSON.stringify(root)});
const role = ${JSON.stringify(role)};
const inside = (target) => {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const real = (p) => {
  try { return fs.realpathSync.native(p); }
  catch { const parent = path.dirname(p); return parent === p ? p : path.join(real(parent), path.basename(p)); }
};
const local = (name, extension, allowAbsolute = false) => {
  if (typeof name !== 'string' || !name || (path.isAbsolute(name) && !allowAbsolute) || name.split(/[\\/]/).some((part) => part === '..' || part === '.') || /[\\0\\r\\n]/.test(name)) return false;
  if (extension && !/\\.dt(?:es)?$/.test(name)) return false;
  const target = path.resolve(root, name);
  return inside(target) && real(target) === target;
};
const read = (command) => {
  if (role === 'run') return command === "rg --files -g '*.dt' -g '*.dtes'" || command === "rg -n '^' -g '*.dt' -g '*.dtes' .";
  if (role !== 'read') return false;
  if (command === 'rg --files' || command === "rg -n '^' .") return true;
  const one = /^rg -n '\\^' -- '([^'\\r\\n\\0]+)'$/.exec(command);
  return !!one && local(one[1], false) && fs.existsSync(path.resolve(root, one[1])) && fs.statSync(path.resolve(root, one[1])).isFile();
};
const patch = (command) => {
  if (role !== 'run' || typeof command !== 'string' || !command.startsWith('*** Begin Patch\\n') || !command.includes('\\n*** End Patch')) return false;
  let files = 0;
  for (const line of command.split('\\n')) {
    if (line.startsWith('*** Move to:')) return false;
    const match = /^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (match) { files++; if (!local(match[1], true, true)) return false; }
  }
  return files > 0;
};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (part) => { input += part; if (input.length > 1024 * 1024) process.exit(2); });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const tool = event?.tool_name;
    const command = event?.tool_input?.command;
    const allowed = (tool === 'Bash' && typeof command === 'string' &&
      (read(command) || (role === 'run' && (/^dt (?:fmt|check)$/.test(command) || /^dt guide(?: --all| [A-Za-z0-9][A-Za-z0-9-]*)?$/.test(command))))) ||
      (tool === 'apply_patch' && patch(command)) ||
      ((role === 'run' || role === 'read') && typeof tool === 'string' && /^mcp__domaintrail__knowledge_(?:for_element|search|get)$/.test(tool));
    if (allowed) return;
  } catch { /* malformed input is denied */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'DomainTrail allows only the tools of this AI role.' } }));
});
`;
}

const shellQuote = (value: string): string => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;

export interface CodexHook {
    /** The value of `-c`: one hook on all local tools. */
    config: string;
    dispose(): Promise<void>;
}

/** A preflight is required: a broken hook can let Codex continue the tool call. */
export async function createCodexHook(root: string, role: CodexHookRole): Promise<CodexHook> {
    const dir = await mkdtemp(path.join(tmpdir(), 'dt-codex-hook-'));
    const file = path.join(dir, 'policy.cjs');
    try {
        await writeFile(file, codexHookSource(root, role), { mode: 0o600 });
        const check = (tool_name: string, command: string, expected: 'allow' | 'deny'): void => {
            const result = spawnSync(process.execPath, [file], {
                input: JSON.stringify({ cwd: root, tool_name, tool_input: { command } }),
                encoding: 'utf8', timeout: 5_000, windowsHide: true,
            });
            if (result.status !== 0) throw new Error('The Codex tool hook failed its local check.');
            if (expected === 'allow' && result.stdout === '') return;
            if (expected === 'deny') {
                try {
                    const decision: unknown = JSON.parse(result.stdout);
                    if (typeof decision === 'object' && decision !== null && 'hookSpecificOutput' in decision &&
                        typeof decision.hookSpecificOutput === 'object' && decision.hookSpecificOutput !== null &&
                        'permissionDecision' in decision.hookSpecificOutput && decision.hookSpecificOutput.permissionDecision === 'deny') return;
                } catch { /* invalid output */ }
            }
            throw new Error('The Codex tool hook failed its local deny/allow check.');
        };
        check('Bash', 'echo unsafe', 'deny');
        if (role !== 'none') check('Bash', role === 'run' ? "rg --files -g '*.dt' -g '*.dtes'" : 'rg --files', 'allow');
        check('apply_patch', '*** Begin Patch\n*** Add File: x.ts\n+test\n*** End Patch', 'deny');
        check('apply_patch', '*** Begin Patch\n*** Add File: x.dt\n+test\n*** End Patch', role === 'run' ? 'allow' : 'deny');
        const command = `${shellQuote(process.execPath)} ${shellQuote(file)}`;
        const config = `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
        return { config, dispose: () => rm(dir, { recursive: true, force: true }) };
    } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
}
