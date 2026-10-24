import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { buildStateGraph, buildStructureGraph } from '../src/graph/build.js';
import { buildContextMapGraph } from '../src/graph/context-map.js';
import type { Graph } from '../src/graph/ir.js';
import { MESSAGES } from '../web/i18n.js';
import { KIND_ORDER } from '../web/model-utils.js';
import { EXAMPLES } from './helpers.js';

const WEB = join(import.meta.dir, '..', 'web');

/** Every text of a message tree, by its path; functions are called with sample arguments. */
function texts(value: unknown, path = ''): [string, string][] {
    if (typeof value === 'string') return [[path, value]];
    if (typeof value === 'function') return texts(value('X', 2), `${path}()`);
    if (isValidElement(value)) return [[path, renderToStaticMarkup(value as ReactNode)]];
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => texts(v, path ? `${path}.${k}` : k));
    return [];
}

/** Latin words of a Japanese text that are not allowed in it. */
const englishIn = (text: string): string[] => (text.replace(/<[^>]*>/g, '').match(/[A-Za-z]+/g) ?? []).filter((w) => !LATIN_IN_JA.has(w));

/** Paths of the message tree (`a.b`), so that the languages can be compared. */
const paths = (value: unknown): string[] =>
    texts(value)
        .map(([p]) => p)
        .sort();

/**
 * Latin words allowed in Japanese messages: abbreviations, the DSL's keywords and file names, which are written as
 * they are in Japanese too. `X` is the sample argument.
 */
const LATIN_IN_JA = new Set(['BC', 'DSL', 'ID', 'OS', 'dt', 'persistent', 'value', 'terms', 'X']);

describe('i18n', () => {
    test('every language has the same messages', () => {
        expect(paths(MESSAGES.en)).toEqual(paths(MESSAGES.ja));
    });

    test('every kind of item has a name', () => {
        for (const kind of [...KIND_ORDER, 'state', 'command', 'context'] as const) {
            expect(MESSAGES.ja.kinds[kind]).toBeTruthy();
            expect(MESSAGES.en.kinds[kind]).toBeTruthy();
        }
    });

    test('Japanese messages leave no English words untranslated', () => {
        const english = texts(MESSAGES.ja).flatMap(([path, text]) => englishIn(text).map((w) => `${path}: ${w}`));
        expect(english).toEqual([]);
    });

    test('Japanese diagrams leave no English words untranslated', async () => {
        const model = (await analyze(await loadWorkspace(EXAMPLES))).model!;
        const contexts = model.contexts.filter((c) => !model.sharedContexts.includes(c));
        const graphs: Graph[] = [
            buildContextMapGraph(model, { all: true }),
            buildStructureGraph(model),
            buildStructureGraph(model, { level: 'aggregates' }),
            // stubs of the other contexts
            ...contexts.flatMap((c) => [buildStructureGraph(model, { focus: [c] }), buildStructureGraph(model, { focus: [c], level: 'aggregates' })]),
            ...Object.values(model.elements)
                .filter((e) => e.kind === 'aggregate')
                .map((agg) => buildStateGraph(agg, model)),
        ];
        // the Live View's own words in diagrams: the captions, and the counts on the context map
        const words = graphs.flatMap((g) =>
            g.nodes.flatMap((n) => [
                ...(n.stereotype ? [n.stereotype.ja.name] : []),
                ...(n.kind === 'boundedContext' ? n.lines.map((l) => l.key.ja.name) : []),
            ]),
        );
        expect(words.length).toBeGreaterThan(0);
        expect([...new Set(words.flatMap(englishIn))]).toEqual([]);
    });

    /**
     * Words of the Live View belong in i18n.tsx: no other component may show a literal text. Literal strings in the
     * transpiled components are suspect when they hold Japanese or a capitalized word; those that are not shown
     * (keys, the product's name) are listed here; module paths are skipped.
     */
    const NOT_SHOWN = new Set(['Escape', 'DomainTrail', 'ID']);

    test('components show no literal text', async () => {
        const transpiler = new Bun.Transpiler({ loader: 'tsx' });
        const files = readdirSync(WEB).filter((f) => f.endsWith('.tsx') && f !== 'i18n.tsx');
        const found: string[] = [];
        for (const file of files) {
            const code = transpiler.transformSync(await Bun.file(join(WEB, file)).text());
            for (const [, double, template] of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
                // the code interpolated into a template is not text
                const quoted = double ?? template.replace(/\$\{[^}]*\}/g, '');
                if (NOT_SHOWN.has(quoted) || quoted.startsWith('.')) continue;
                if (/[\u3040-\u30ff\u4e00-\u9fff]|\b[A-Z][a-z]+\b/.test(quoted)) found.push(`${file}: ${quoted}`);
            }
        }
        expect(found).toEqual([]);
    });
});
