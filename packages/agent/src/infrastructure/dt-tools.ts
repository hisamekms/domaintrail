// `dt fmt` and `dt check` after the agent (ADR 0026, S6), run with this very CLI (the runtime that runs it and its
// entry), never a `dt` found on the PATH, as an argument array in the workspace root. `dt fmt` leaves a file with
// syntax errors untouched and exits 1; `dt check` exits 1 on errors: both still ran. Exit 2 (an invalid config), a
// signal or a failure to start means it did not. Their output is not kept: the server analyzes the result itself.
import { spawn } from 'node:child_process';
import type { DslTools } from '../application/ports.js';

/** How `dt` is started: the runtime and the CLI's entry (e.g. `process.execPath` and `dist/dt.js`). */
export interface DtCommand {
    readonly command: string;
    readonly args: readonly string[];
}

export interface DtToolsOptions {
    readonly dt: DtCommand;
    /** The workspace root (`-r`) and the explicit config file (`-c`), if one was given. */
    readonly root: string;
    readonly configPath?: string;
    readonly log: (line: string) => void;
}

/** How long one command may take. */
const TIMEOUT_MS = 5 * 60_000;

function run(options: DtToolsOptions, command: string): Promise<number | null> {
    const args = [...options.dt.args, '-r', options.root, ...(options.configPath ? ['-c', options.configPath] : []), command];
    return new Promise((resolve, reject) => {
        const child = spawn(options.dt.command, args, {
            cwd: options.root,
            shell: false,
            stdio: ['ignore', 'ignore', 'ignore'],
            timeout: TIMEOUT_MS,
            windowsHide: true,
        });
        child.once('error', reject);
        child.once('close', (code) => resolve(code));
    });
}

export function createDtTools(options: DtToolsOptions): DslTools {
    const ran = async (command: string): Promise<boolean> => {
        try {
            const code = await run(options, command);
            if (code !== 0 && code !== 1) options.log(`dt ${command} did not run (exit ${code ?? 'by a signal'})`);
            return code === 0 || code === 1;
        } catch (e) {
            options.log(`dt ${command} could not start: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    };
    return { format: () => ran('fmt'), check: () => ran('check') };
}
