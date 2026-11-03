// What the site's scripts share: where things are, and how `dt` is run.
//
// `dt` is the repository's own CLI, from source (`bun ../bin/dt.ts`) unless DT names another command (the workflow
// sets `DT="node ../dist/dt.js"` after `bun run build`). Run the scripts with the state env of a scratch dir
// (DOMAINTRAIL_STATE_DIR, XDG_STATE_HOME, XDG_CACHE_HOME) when they must not touch yours: they pass the env on.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(SITE, '..');
export const EXAMPLES = join(SITE, 'examples');

/** The `dt` command line, before its arguments. */
export function dtCommand(): readonly string[] {
    const configured = process.env.DT?.trim();
    return configured ? configured.split(/\s+/) : [process.execPath, join(REPO, 'bin', 'dt.ts')];
}

export interface Ran {
    readonly code: number;
    readonly out: string;
}

/** Runs `dt` with these arguments to its end, from the site's directory. */
export function dt(args: readonly string[]): Ran {
    const [cmd, ...pre] = dtCommand();
    const r = spawnSync(cmd, [...pre, ...args], { cwd: SITE, encoding: 'utf8', env: process.env });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Starts `dt` with these arguments in the background (`dt open`), its output piped. */
export function dtStart(args: readonly string[]): ReturnType<typeof spawn> {
    const [cmd, ...pre] = dtCommand();
    return spawn(cmd, [...pre, ...args], { cwd: SITE, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The guide whose examples the scripts know (examples/<guide>/<phase>/, one workspace per phase of its workshop). */
export const ES = 'event-storming';
export const ES_EXAMPLES = join(EXAMPLES, ES);

/** The Event Storming guide's example workspaces, one per phase of the workshop, in the order of the phases. */
export const PHASES = ['events', 'flows', 'exceptions', 'questions', 'design'] as const;
export type Phase = (typeof PHASES)[number];

/** Every example workspace on disk, as `<guide>/<example>`, the Event Storming phases first and in their order. */
export function exampleDirs(): string[] {
    const subdirs = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    const all = subdirs(EXAMPLES).flatMap((guide) => subdirs(join(EXAMPLES, guide)).map((example) => `${guide}/${example}`));
    const es = PHASES.map((p) => `${ES}/${p}`).filter((d) => all.includes(d));
    return [...es, ...all.filter((d) => !es.includes(d))];
}
