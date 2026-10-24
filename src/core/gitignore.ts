import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * The `.gitignore` rules that apply below a root, with git's semantics: the `.gitignore` files of the root and of its
 * subdirectories, those of the directories above it up to the top of the enclosing git repository, and that
 * repository's `.git/info/exclude`. A deeper file's rules win over a higher one's, and nothing below an ignored
 * directory is included again. Without an enclosing repository, only the files from the root down apply. The root
 * itself is never ignored: when the rules above it ignore it (a copy of a project inside an ignored directory, checked
 * with `-r`), only the `.gitignore` files from the root down apply.
 *
 * Files are read once, when first needed.
 */
export class GitIgnore {
    /** The directory the rules are relative to: the top of the repository, else the root. */
    private readonly base: string;
    /** The rules that apply inside a directory (its own `.gitignore` and those above it), by absolute path. */
    private readonly rules = new Map<string, Ignore>();

    constructor(root: string) {
        root = path.resolve(root);
        const top = repositoryTop(root);
        this.base = top ?? root;
        this.rules.set(this.base, rules().add(top ? infoExclude(top) : []).add(readGitignore(this.base, '')));
        if (this.base !== root && this.rulesFor(path.dirname(root)).ignores(`${slashed(path.relative(this.base, root))}/`)) {
            this.base = root;
            this.rules.clear();
            this.rules.set(root, rules().add(readGitignore(root, '')));
        }
    }

    /** Whether `file` (a path below the root) is ignored; `directory` when it is a directory. */
    ignores(file: string, directory: boolean): boolean {
        file = path.resolve(file);
        const rel = slashed(path.relative(this.base, file));
        if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return false;
        return this.rulesFor(path.dirname(file)).ignores(directory ? `${rel}/` : rel);
    }

    private rulesFor(dir: string): Ignore {
        const known = this.rules.get(dir);
        if (known) return known;
        const rel = slashed(path.relative(this.base, dir));
        if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return this.rules.get(this.base)!;
        const inside = rules().add(this.rulesFor(path.dirname(dir))).add(readGitignore(dir, rel));
        this.rules.set(dir, inside);
        return inside;
    }
}

/** Patterns match case-sensitively, as git does unless `core.ignorecase` is set. */
const rules = (): Ignore => ignore({ ignorecase: false });

const slashed = (p: string): string => p.split(path.sep).join('/');

/** The directory holding `.git` (a directory, or a file in a worktree or submodule) at or above `dir`. */
function repositoryTop(dir: string): string | undefined {
    for (;;) {
        if (statSync(path.join(dir, '.git'), { throwIfNoEntry: false })) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** `info/exclude` of the repository at `top`, in the common git directory when `.git` is a worktree's file. */
function infoExclude(top: string): string[] {
    let gitDir = path.join(top, '.git');
    if (statSync(gitDir).isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readText(gitDir) ?? '')?.[1]?.trim();
        if (!pointer) return [];
        gitDir = path.resolve(top, pointer);
        const common = readText(path.join(gitDir, 'commondir'))?.trim();
        if (common) gitDir = path.resolve(gitDir, common);
    }
    return patterns(readText(path.join(gitDir, 'info', 'exclude')) ?? '', '');
}

function readText(file: string): string | undefined {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** The patterns of `dir/.gitignore`, rewritten relative to the base (`prefix` is `dir` relative to it). */
function readGitignore(dir: string, prefix: string): string[] {
    return patterns(readText(path.join(dir, '.gitignore')) ?? '', prefix);
}

/**
 * Rewrites the patterns of a file in the directory `prefix` so that they apply relative to the base, as one list of
 * rules where later ones win: a pattern with a slash before its end is anchored to its directory, one without matches
 * at any depth below it.
 */
function patterns(text: string, prefix: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/(?<!\\)\s+$/, '');
        if (!line || line.startsWith('#')) continue;
        if (!prefix) {
            out.push(line);
            continue;
        }
        const negated = line.startsWith('!');
        const pattern = negated ? line.slice(1) : line;
        const anchored = pattern.replace(/\/$/, '').includes('/');
        out.push(`${negated ? '!' : ''}${prefix}/${anchored ? pattern.replace(/^\//, '') : `**/${pattern}`}`);
    }
    return out;
}
