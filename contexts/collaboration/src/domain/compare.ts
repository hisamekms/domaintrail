// The comparison of two revisions (ADR 0026, S7), decided without I/O: the status of each source by path (added,
// removed, changed, unchanged) with its DSL, and a unified line diff of a file's two texts. The diff is Myers' O(ND)
// algorithm on lines, bounded before the work is done: a side larger than `MAX_DIFF_BYTES` (checked by the caller before
// it reads the blob, and here) or longer than `MAX_DIFF_LINES` lines, or a difference of more than `MAX_EDITS` edits, is
// not diffed (`tooLarge`: changed, diff omitted); a line is shown up to `MAX_LINE_CHARS` characters; the unified text
// stops at `MAX_OUTPUT_LINES` lines or at the caller's character budget (`truncated`).
import type { Collaboration } from '../generated/index.js';
import { comparePaths } from './snapshot.js';

/** Largest side, in bytes (UTF-8) or characters, that is diffed. */
export const MAX_DIFF_BYTES = 1024 * 1024;
/** Longest side, in lines, that is diffed: the search is O((N + M) · D) with D ≤ `MAX_EDITS`. */
export const MAX_DIFF_LINES = 10_000;
/** Longest line shown; a longer one is cut, with `LINE_CUT` after it. */
export const MAX_LINE_CHARS = 1_000;
export const LINE_CUT = ' …[cut]';
/** Most edits (inserted plus removed lines) a diff looks for: the work and memory are bounded by its square. */
export const MAX_EDITS = 1_000;
/** Longest unified text of one file, in lines. */
export const MAX_OUTPUT_LINES = 2_000;
/** Lines of context around a change. */
export const CONTEXT_LINES = 3;

export type FileStatus = 'added' | 'removed' | 'changed' | 'unchanged';

/** A file of either revision, by path: its status, its language, and its hash on each side. */
export interface FileComparison {
    readonly path: Collaboration.WorkspacePath;
    readonly language: Collaboration.SourceLanguage;
    readonly status: FileStatus;
    /** The hash in the first revision; absent when the file was added. */
    readonly before?: Collaboration.ContentHash;
    /** The hash in the second revision; absent when the file was removed. */
    readonly after?: Collaboration.ContentHash;
}

/** A unified line diff: `---`/`+++` headers are left to the reader (the path is beside it). */
export type LineDiff =
    | {
          readonly kind: 'diff';
          /** Hunks with `@@ -a,b +c,d @@` headers, lines starting with ` `, `-` or `+`, and `\ No newline at end of file`. */
          readonly unified: string;
          readonly added: number;
          readonly removed: number;
          /** The unified text was cut after `MAX_OUTPUT_LINES` lines (the counts are complete). */
          readonly truncated: boolean;
      }
    | { readonly kind: 'tooLarge' };

type File = Pick<Collaboration.SnapshotFile, 'path' | 'language' | 'hash'>;

/** The files of two revisions by path, sorted: each with its status. */
export function compareFiles(before: readonly File[], after: readonly File[]): FileComparison[] {
    const was = new Map(before.map((f) => [f.path, f]));
    const is = new Map(after.map((f) => [f.path, f]));
    const paths = [...new Set([...was.keys(), ...is.keys()])].sort(comparePaths);
    return paths.map((path) => {
        const a = was.get(path);
        const b = is.get(path);
        if (!a && b) return { path, language: b.language, status: 'added', after: b.hash };
        if (a && !b) return { path, language: a.language, status: 'removed', before: a.hash };
        if (!a || !b) throw new Error(`No file at ${path}`);
        return { path, language: b.language, status: a.hash === b.hash ? 'unchanged' : 'changed', before: a.hash, after: b.hash };
    });
}

/** The count of each status per language. */
export function statusCounts(files: readonly FileComparison[]): Record<Collaboration.SourceLanguage, Record<FileStatus, number>> {
    const zero = (): Record<FileStatus, number> => ({ added: 0, removed: 0, changed: 0, unchanged: 0 });
    const counts = { Dt: zero(), Dtes: zero() };
    for (const f of files) counts[f.language][f.status]++;
    return counts;
}

/** A text as lines, without their line ends; whether its last line ends with one. An empty text has no line. */
function linesOf(text: string): { lines: string[]; eol: boolean } {
    if (text === '') return { lines: [], eol: true };
    const lines = text.split(/\r?\n/);
    const eol = lines.at(-1) === '';
    if (eol) lines.pop();
    return { lines, eol };
}

interface Op {
    readonly op: ' ' | '-' | '+';
    /** The index of the line in the first text (for an insertion: of the line it comes before). */
    readonly a: number;
    /** The index of the line in the second text (for a removal: of the line it comes before). */
    readonly b: number;
}

/**
 * The shortest edit script from `a` to `b` (Myers 1986), or `undefined` when it has more than `maxEdits` edits. The
 * frontier of each round is kept for the way back: memory and time are O((N + M) · D) with D ≤ `maxEdits`.
 */
function shortestEdit(a: readonly string[], b: readonly string[], maxEdits: number): Op[] | undefined {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, maxEdits);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, offset, n, m);
        }
    }
    return undefined;
}

function backtrack(trace: readonly Int32Array[], offset: number, n: number, m: number): Op[] {
    const ops: Op[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = d === 0 ? 0 : v[offset + prevK];
        const prevY = d === 0 ? 0 : prevX - prevK;
        while (x > prevX && y > prevY) {
            x--;
            y--;
            ops.push({ op: ' ', a: x, b: y });
        }
        if (d > 0) {
            if (x === prevX) ops.push({ op: '+', a: x, b: prevY });
            else ops.push({ op: '-', a: prevX, b: y });
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}

/** The hunks of an edit script with `context` lines around each change; hunks closer than twice that are merged. */
function hunks(ops: readonly Op[], context: number): [number, number][] {
    const changes = ops.flatMap((o, i) => (o.op === ' ' ? [] : [i]));
    const ranges: [number, number][] = [];
    for (const i of changes) {
        const start = Math.max(0, i - context);
        const end = Math.min(ops.length - 1, i + context);
        const last = ranges.at(-1);
        if (last && start <= last[1] + 1) last[1] = end;
        else ranges.push([start, end]);
    }
    return ranges;
}

/**
 * The unified diff of two texts (UTF-8 sources) with `CONTEXT_LINES` lines of context, bounded (see the module's
 * comment). A line end that differs only at the end of the file is shown as `\ No newline at end of file`.
 */
export function lineDiff(before: string, after: string, budget = Number.POSITIVE_INFINITY): LineDiff {
    if (before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES) return { kind: 'tooLarge' };
    const a = linesOf(before);
    const b = linesOf(after);
    if (a.lines.length > MAX_DIFF_LINES || b.lines.length > MAX_DIFF_LINES) return { kind: 'tooLarge' };
    // the last line of a text without a final line end is another line than the same text with one
    const NOEOL = '\u0000';
    const keys = (t: { lines: string[]; eol: boolean }): string[] => (t.eol ? t.lines : t.lines.map((l, i) => (i === t.lines.length - 1 ? l + NOEOL : l)));
    const ka = keys(a);
    const kb = keys(b);

    // the common start and end are not searched
    let start = 0;
    while (start < ka.length && start < kb.length && ka[start] === kb[start]) start++;
    let end = 0;
    while (end < ka.length - start && end < kb.length - start && ka[ka.length - 1 - end] === kb[kb.length - 1 - end]) end++;
    const ma = ka.slice(start, ka.length - end);
    const mb = kb.slice(start, kb.length - end);
    // only removed or only added lines (a file added or removed, a block inserted) need no search
    const middle =
        ma.length === 0 || mb.length === 0
            ? [...ma.map((_, i): Op => ({ op: '-', a: i, b: 0 })), ...mb.map((_, i): Op => ({ op: '+', a: 0, b: i }))]
            : shortestEdit(ma, mb, MAX_EDITS);
    if (!middle) return { kind: 'tooLarge' };
    const ops: Op[] = [];
    for (let i = 0; i < start; i++) ops.push({ op: ' ', a: i, b: i });
    for (const o of middle) ops.push({ op: o.op, a: o.a + start, b: o.b + start });
    for (let i = end; i > 0; i--) ops.push({ op: ' ', a: ka.length - i, b: kb.length - i });

    const out: string[] = [];
    let truncated = false;
    let left = budget;
    // each line is counted against the budget as it is emitted: nothing is built past it
    const emit = (raw: string): void => {
        if (truncated) return;
        const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) + LINE_CUT : raw;
        if (out.length >= MAX_OUTPUT_LINES || line.length + 1 > left) {
            truncated = true;
            return;
        }
        left -= line.length + 1;
        out.push(line);
    };
    for (const [from, to] of hunks(ops, CONTEXT_LINES)) {
        if (truncated) break;
        const span = ops.slice(from, to + 1);
        const aLen = span.filter((o) => o.op !== '+').length;
        const bLen = span.filter((o) => o.op !== '-').length;
        const aStart = aLen ? span[0].a + 1 : span[0].a;
        const bStart = bLen ? span[0].b + 1 : span[0].b;
        emit(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
        for (const o of span) {
            const key = o.op === '+' ? kb[o.b] : ka[o.a];
            const noEol = key.endsWith(NOEOL);
            emit(`${o.op}${noEol ? key.slice(0, -1) : key}`);
            if (noEol) emit('\\ No newline at end of file');
        }
    }
    return {
        kind: 'diff',
        unified: out.join('\n'),
        added: ops.filter((o) => o.op === '+').length,
        removed: ops.filter((o) => o.op === '-').length,
        truncated,
    };
}
