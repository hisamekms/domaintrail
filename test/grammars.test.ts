// The two Langium grammars, Modeling's `.dt` and Storming's `.dtes` (one Langium project per context, ADR 0027): the
// `.dtes` lexer is the `.dt` one (spec §14 item 1), so every terminal of the storming grammar is written exactly as in
// the domain grammar, with the same hiddenness, and only INT and DECIMAL are left out.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');
const DOMAIN = path.join(ROOT, 'packages', 'modeling', 'src', 'language', 'domain.langium');
const STORMING = path.join(ROOT, 'contexts', 'storming', 'src', 'infrastructure', 'syntax', 'storming.langium');

/** The terminal rules of a grammar by name: the rule as written, after its name. */
async function terminals(file: string): Promise<Record<string, string>> {
    const grammar = await readFile(file, 'utf8');
    return Object.fromEntries([...grammar.matchAll(/^(hidden )?terminal (\w+)(.*)$/gm)].map((m) => [m[2], `${m[1] ?? ''}terminal ${m[2]}${m[3]}`]));
}

describe('the terminals of the .dt and .dtes grammars', () => {
    test('every .dtes terminal is the .dt one, verbatim and with the same hiddenness; only INT and DECIMAL are left out', async () => {
        const dt = await terminals(DOMAIN);
        const es = await terminals(STORMING);
        expect(Object.keys(es).sort()).toEqual(['ID', 'ML_COMMENT', 'SL_COMMENT', 'STRING', 'WS']);
        for (const [name, rule] of Object.entries(es)) expect({ name, rule }).toEqual({ name, rule: dt[name] });
        expect(
            Object.keys(dt)
                .filter((n) => !(n in es))
                .sort(),
        ).toEqual(['DECIMAL', 'INT']);
    });
});
