// What the AI may read outside the workspace (`agent.read.paths` for both roles, `agent.answer.read.paths` and
// `agent.run.read.paths` for one; the maintainer's decision of 2026-11-03): directories or files, read-only. The
// configuration's check (`checkReadPaths`, after the pure validation): a path inside the workspace, one holding it, one
// in a `.git` or `.domaintrail` directory, or one inside or holding dt's own state or cache directory (`own`: where the
// sessions of every workspace are kept, outside them; the app gives them) is an error, symbolic links followed (an extra path never re-admits what
// the workspace's rules keep out). When the agent starts (`readTargets`), each path is taken by its real path and
// checked again; one that is missing (or became one of the above) is skipped and said. What is readable inside them
// (the files git does not ignore there, else every file; never `.git` nor `.domaintrail`) is the wiring's: views for
// the answerer, deny rules for the runner (`ExtraRead`, ./claude-code.ts).
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { type AgentConfigFile, resolveReadPath } from './config.js';
import { inside } from './dt-shim.js';
import { foldedName } from './workspace-view.js';

/** A path the AI reads outside the workspace, as it really is when the agent starts. */
export interface ReadTarget {
    /** As configured (resolved: absolute). */
    readonly configured: string;
    /** Its real path (symbolic links followed). */
    readonly real: string;
    readonly directory: boolean;
    /** Its device and inode when the agent started (`dev:ino`): what `checkTarget` compares with. */
    readonly id: string;
}

/** The device and inode of `p` (links followed), or none. */
const idOf = (p: string): string | undefined => {
    const s = statSync(p, { bigint: true, throwIfNoEntry: false });
    return s && `${s.dev}:${s.ino}`;
};

/**
 * Refuses (throws) when `target` is no longer what the agent started with: its configured path now resolves to another
 * real path, or that path is another file or directory (replaced, or a link moved). Asked before each turn of the
 * answerer and each run: the turn or run fails rather than read something else.
 */
export function checkTarget(target: ReadTarget): void {
    let real: string | undefined;
    try {
        real = realpathSync.native(target.configured);
    } catch {
        real = undefined;
    }
    if (real !== target.real || idOf(target.real) !== target.id)
        throw new Error(
            `${target.configured} changed since the agent started (it was ${target.real}${real === undefined ? ', now missing' : real === target.real ? ', now another file or directory' : `, now ${real}`}): restart the agent to read it again.`,
        );
}

/** Whether a part of `p` is `.git` or `.domaintrail`, in any case or Unicode form. */
const ownPart = (p: string): boolean => p.split(/[\\/]/).some((s) => foldedName(s) === '.git' || foldedName(s) === '.domaintrail');

/** The real path of `p`, or `p` when it does not exist. */
const realOr = (p: string): string => {
    try {
        return realpathSync.native(p);
    } catch {
        return p;
    }
};

/**
 * Where secrets live: a read path that is one, or holds one, is refused; so is one inside one (`inside: true`), except
 * the temporary directories' parents (`/var`) and `~/Library` (iCloud Drive's documents are there).
 */
const SENSITIVE: readonly { readonly at: string; readonly home?: true; readonly inside: boolean }[] = [
    ...['.ssh', '.gnupg', '.aws', '.azure', '.config', '.kube', '.docker', '.netrc'].map((at) => ({ at, home: true as const, inside: true })),
    { at: 'Library', home: true, inside: false },
    { at: '/etc', inside: true },
    { at: '/private/etc', inside: true },
    { at: '/var', inside: false },
    { at: '/private/var', inside: false },
];

/** Why `p` (absolute) touches a place where secrets live, if it does; `home`: the user's home directory. Links followed. */
function sensitiveError(p: string, home: string): string | undefined {
    const real = realOr(p);
    if (path.dirname(real) === real) return 'it is the root of the file system';
    if (inside(p, home) && inside(home, p)) return 'it is your home directory';
    for (const s of SENSITIVE) {
        const at = s.home ? path.join(home, s.at) : s.at;
        const shown = s.home ? `~/${s.at}` : s.at;
        if (inside(p, at)) return `it is or holds ${shown}, where secrets live`;
        if (s.inside && inside(at, p)) return `it is inside ${shown}, where secrets live`;
    }
    return undefined;
}

/** Why `p` (absolute) touches one of dt's own directories `own` (the state and cache roots), if it does. Links followed. */
function ownDirError(p: string, own: readonly string[], home: string): string | undefined {
    for (const at of own) {
        const shown = shownReadPath(at, home);
        if (inside(p, at)) return `it is or holds ${shown}, where dt keeps the sessions, which the AI never reads`;
        if (inside(at, p)) return `it is inside ${shown}, where dt keeps the sessions, which the AI never reads`;
    }
    return undefined;
}

/**
 * Why the AI may not read `p` (absolute) beside the workspace `workspace`, if it may not; links followed. `home`: the
 * user's home directory (for the places where secrets live); `own`: dt's state and cache roots.
 */
export function readPathError(p: string, workspace: string, home: string = homedir(), own: readonly string[] = []): string | undefined {
    const sensitive = sensitiveError(p, home) ?? ownDirError(p, own, home);
    if (sensitive) return sensitive;
    if (inside(workspace, p)) return 'it is inside the workspace, which the AI reads already (what git ignores there stays out)';
    if (inside(p, workspace)) return 'it holds the workspace: name the directories or files beside it instead';
    if (ownPart(p) || ownPart(realOr(p))) return 'it is in a .git or .domaintrail directory, which the AI never reads';
    return undefined;
}

/** The `read` parts of `agent`, by where they sit. */
const readParts = (agent: AgentConfigFile | undefined): [string, readonly string[] | undefined][] => [
    ['agent.read.paths', agent?.read?.paths],
    ['agent.answer.read.paths', agent?.answer?.read?.paths],
    ['agent.run.read.paths', agent?.run?.read?.paths],
];

/**
 * Refuses a configured read path (as written, `dir` the config file's directory: the workspace) that lies inside the
 * workspace, holds it, is in a `.git` or `.domaintrail` directory, or inside or holding one of `own` (dt's state and
 * cache roots). A path that does not exist is not refused here: the agent skips it when it starts, and says so.
 */
export function checkReadPaths(
    agent: AgentConfigFile | undefined,
    dir: string,
    fail: (msg: string) => never,
    home: string = homedir(),
    own: readonly string[] = [],
): void {
    for (const [at, paths] of readParts(agent)) {
        for (const p of paths ?? []) {
            const why = readPathError(resolveReadPath(p, dir, home), dir, home, own);
            if (why) fail(`'${at}' names ${JSON.stringify(p)}: ${why}`);
        }
    }
}

/**
 * The paths (resolved) as the agent reads them when it starts: by their real paths, each once, a directory or a
 * regular file; `skipped` says why the others are not read (missing, or refused by `readPathError` since the check).
 */
export function readTargets(
    paths: readonly string[],
    workspace: string,
    home: string = homedir(),
    own: readonly string[] = [],
): { readonly targets: ReadTarget[]; readonly skipped: string[] } {
    const targets: ReadTarget[] = [];
    const skipped: string[] = [];
    for (const configured of paths) {
        let real: string;
        try {
            real = realpathSync.native(configured);
        } catch {
            skipped.push(`${configured} (not found)`);
            continue;
        }
        const why = readPathError(real, workspace, home, own);
        if (why) {
            skipped.push(`${configured} (${why})`);
            continue;
        }
        const s = statSync(real, { bigint: true, throwIfNoEntry: false });
        if (!s?.isDirectory() && !s?.isFile()) {
            skipped.push(`${configured} (not a directory or a regular file)`);
            continue;
        }
        if (!targets.some((t) => t.real === real)) targets.push({ configured, real, directory: s.isDirectory(), id: `${s.dev}:${s.ino}` });
    }
    return { targets, skipped };
}

/** A path for people: `~/…` below the home directory `home`. */
export function shownReadPath(p: string, home: string): string {
    const rel = path.relative(home, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : p;
}
