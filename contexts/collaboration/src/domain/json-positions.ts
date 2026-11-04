// JSON read with where each value is (the journey file's diagnostics name a line and a column): a small parser of the
// JSON grammar (RFC 8259) that returns the value and the offsets of each value and member key by path (`a.b[0].c`), or
// the offset of the first syntax error. Pure.

/** Where a value is in the text: its offsets, and its member key's when it is an object's member. */
export interface JsonSpan {
    readonly start: number;
    readonly end: number;
    readonly keyStart?: number;
    readonly keyEnd?: number;
}

/** A JSON text read: its value and where each part is, or the first syntax error. */
export type JsonRead =
    | { readonly ok: true; readonly value: unknown; readonly spans: ReadonlyMap<string, JsonSpan> }
    | { readonly ok: false; readonly offset: number; readonly message: string };

/** The path of a member (`a.b`, a key that is no identifier quoted: `a["x y"]`) or an item (`a[0]`). */
export const memberPath = (parent: string, key: string): string =>
    /^[A-Za-z_$][\w$]*$/u.test(key) ? (parent ? `${parent}.${key}` : key) : `${parent}[${JSON.stringify(key)}]`;
export const itemPath = (parent: string, index: number): string => `${parent}[${index}]`;

class Fail extends Error {
    constructor(
        readonly offset: number,
        message: string,
    ) {
        super(message);
    }
}

/** Reads `text` as JSON, with the spans of its values by path (`''`: the whole value). */
export function readJsonWithSpans(text: string): JsonRead {
    const spans = new Map<string, JsonSpan>();
    let i = 0;
    const ws = (): void => {
        while (i < text.length && ' \t\n\r'.includes(text[i] ?? '')) i += 1;
    };
    const expect = (c: string): void => {
        if (text[i] !== c) throw new Fail(i, i >= text.length ? `Expected '${c}', found the end.` : `Expected '${c}'.`);
        i += 1;
    };
    const str = (): string => {
        const start = i;
        expect('"');
        let out = '';
        for (;;) {
            if (i >= text.length) throw new Fail(start, 'Unterminated string.');
            const c = text[i] ?? '';
            if (c === '"') {
                i += 1;
                return out;
            }
            if (c < ' ') throw new Fail(i, 'A control character in a string.');
            if (c === '\\') {
                const e = text[i + 1] ?? '';
                const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
                if (e in simple) {
                    out += simple[e];
                    i += 2;
                } else if (e === 'u' && /^[0-9a-fA-F]{4}$/u.test(text.slice(i + 2, i + 6))) {
                    out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
                    i += 6;
                } else throw new Fail(i, 'A bad escape in a string.');
                continue;
            }
            out += c;
            i += 1;
        }
    };
    const value = (path: string, key?: { start: number; end: number }): unknown => {
        ws();
        const start = i;
        let v: unknown;
        const c = text[i];
        if (c === '{') {
            i += 1;
            const o: Record<string, unknown> = {};
            ws();
            if (text[i] === '}') i += 1;
            else
                for (;;) {
                    ws();
                    const ks = i;
                    const k = str();
                    const ke = i;
                    ws();
                    expect(':');
                    if (Object.hasOwn(o, k)) throw new Fail(ks, `The key '${k}' is written twice.`);
                    o[k] = value(memberPath(path, k), { start: ks, end: ke });
                    ws();
                    if (text[i] === ',') {
                        i += 1;
                        continue;
                    }
                    expect('}');
                    break;
                }
            v = o;
        } else if (c === '[') {
            i += 1;
            const a: unknown[] = [];
            ws();
            if (text[i] === ']') i += 1;
            else
                for (;;) {
                    a.push(value(itemPath(path, a.length)));
                    ws();
                    if (text[i] === ',') {
                        i += 1;
                        continue;
                    }
                    expect(']');
                    break;
                }
            v = a;
        } else if (c === '"') v = str();
        else {
            const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i));
            if (!m) throw new Fail(i, i >= text.length ? 'Unexpected end of the file.' : 'Unexpected character.');
            i += m[0].length;
            v = m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'null' ? null : Number(m[0]);
        }
        spans.set(path, { start, end: i, ...(key && { keyStart: key.start, keyEnd: key.end }) });
        return v;
    };
    try {
        // a byte order mark is not JSON, but editors write one
        if (text.charCodeAt(0) === 0xfeff) i = 1;
        const v = value('');
        ws();
        if (i < text.length) throw new Fail(i, 'Unexpected text after the value.');
        return { ok: true, value: v, spans };
    } catch (e) {
        if (e instanceof Fail) return { ok: false, offset: e.offset, message: e.message };
        throw e;
    }
}

/** The 1-based line and column of an offset of `text`. */
export function lineColumn(text: string, offset: number): { readonly line: number; readonly column: number } {
    let line = 1;
    let last = 0;
    for (let k = 0; k < Math.min(offset, text.length); k++) {
        if (text[k] === '\n') {
            line += 1;
            last = k + 1;
        }
    }
    return { line, column: offset - last + 1 };
}
