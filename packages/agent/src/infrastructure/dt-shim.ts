// The agent's `dt` (ADR 0026): a directory holding one executable `dt` that runs the configured command (by default
// this very CLI: its runtime and its entry), put first on the agent's PATH. The prompt and the allowed tools stay
// `dt fmt` / `dt check`, whatever `dt` is (or is not) installed on the facilitator's machine.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DtCommand } from './dt-tools.js';

/** A word quoted for `sh`: inside single quotes, a quote closed, escaped and reopened. */
const shQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;
/** A word quoted for `cmd.exe`: in double quotes, which a path cannot contain. */
const cmdQuote = (word: string): string => `"${word.replaceAll('"', '""')}"`;

/** The shim's file name and text for the platform: a `sh` script, or a `.cmd` file on Windows. */
export function dtShim(dt: DtCommand, platform: NodeJS.Platform = process.platform): { readonly file: string; readonly text: string } {
    const words = [dt.command, ...dt.args];
    for (const w of words) if (w === '' || /[\0\r\n]/.test(w)) throw new Error(`Not a command word: ${JSON.stringify(w)}`);
    if (platform === 'win32') return { file: 'dt.cmd', text: `@echo off\r\n${words.map(cmdQuote).join(' ')} %*\r\n` };
    return { file: 'dt', text: `#!/bin/sh\nexec ${words.map(shQuote).join(' ')} "$@"\n` };
}

/** The environment with `dir` first on its PATH (the key keeps its case, `Path` on Windows). */
export function withPathFirst(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const rest = env[key];
    return { ...env, [key]: rest ? `${dir}${path.delimiter}${rest}` : dir };
}

/** Writes the shim in a new private directory; `dispose` removes it. */
export async function writeDtShim(dt: DtCommand): Promise<{ readonly dir: string; dispose(): Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dt-'));
    const shim = dtShim(dt);
    const file = path.join(dir, shim.file);
    await writeFile(file, shim.text, { mode: 0o700 });
    await chmod(file, 0o700);
    return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}
