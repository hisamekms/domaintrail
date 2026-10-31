import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Language, Parser, Query, type Node } from 'web-tree-sitter';
import { loadWorkspace } from '@domaintrail/workspace/infrastructure/files';
import { GRAMMAR_DIR, STAMP, hashes } from '../scripts/tree-sitter.js';
import { EXAMPLES } from './helpers.js';

// The tree-sitter grammar (tree-sitter-domaintrail, for editors) must parse what the Langium grammar parses. It is
// checked with the committed wasm; `bun run tree-sitter` rebuilds it after a change of grammar.js.

const ROOT = path.join(import.meta.dir, '..');
const ZED_LANGUAGE = path.join(ROOT, 'editors', 'zed', 'languages', 'domaintrail');

let parser: Parser;
let language: Language;

beforeAll(async () => {
    await Parser.init();
    language = await Language.load(path.join(GRAMMAR_DIR, 'tree-sitter-domaintrail.wasm'));
    parser = new Parser();
    parser.setLanguage(language);
});

/** The ERROR and MISSING nodes of a parse, as `line:column kind` (1-based). */
function problems(text: string): string[] {
    const found: string[] = [];
    const visit = (node: Node): void => {
        if (node.isError || node.isMissing) {
            found.push(`${node.startPosition.row + 1}:${node.startPosition.column + 1} ${node.isMissing ? `MISSING ${node.type}` : 'ERROR'}`);
        }
        if (node.hasError || node.isMissing) for (const child of node.children) if (child) visit(child);
    };
    const tree = parser.parse(text)!;
    visit(tree.rootNode);
    tree.delete();
    return found;
}

const dtBlocks = async (file: string): Promise<string[]> =>
    [...(await readFile(path.join(ROOT, file), 'utf8')).matchAll(/^```dt\n([\s\S]*?)^```/gm)].map((m) => m[1]);

describe('tree-sitter grammar', () => {
    test('the committed wasm is built from grammar.js (run `bun run tree-sitter` after changing it)', async () => {
        expect(JSON.parse(await readFile(STAMP, 'utf8'))).toEqual(await hashes());
    });

    test('parses every .dt file of examples/shop', async () => {
        const sources = (await loadWorkspace(EXAMPLES)).filter((s) => s.path.endsWith('.dt'));
        expect(sources.length).toBeGreaterThan(0);
        for (const s of sources) expect({ file: s.path, problems: problems(s.text) }).toEqual({ file: s.path, problems: [] });
    });

    test('parses every dt block of the guide, the README and Getting started', async () => {
        for (const file of ['docs/guide.md', 'README.md', 'docs/getting-started.md', 'docs/getting-started.ja.md']) {
            const blocks = await dtBlocks(file);
            expect(blocks.length).toBeGreaterThan(0);
            blocks.forEach((text, k) => expect({ file, block: k + 1, problems: problems(text) }).toEqual({ file, block: k + 1, problems: [] }));
        }
    });

    test('reports a syntax error', () => {
        expect(problems('context A { id X UUID }')).not.toEqual([]);
        expect(problems('context A { aggregate G { command c() -> } }')).not.toEqual([]);
    });

    test('takes the keywords that may name fields from the Langium grammar', async () => {
        const langium = await readFile(path.join(ROOT, 'packages', 'modeling', 'src', 'language', 'domain.langium'), 'utf8');
        const grammar = await readFile(path.join(GRAMMAR_DIR, 'grammar.js'), 'utf8');
        const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
        expect(quoted(/FEATURE_KEYWORDS = \[([^\]]*)\]/.exec(grammar)![1])).toEqual(quoted(/FeatureName returns string:([^;]*);/.exec(langium)![1]));
        expect(quoted(/primitive_type: \(_\) => choice\(([^)]*)\)/.exec(grammar)![1])).toEqual(
            quoted(/PrimitiveType returns string:([^;]*);/.exec(langium)![1]),
        );
    });

    test('its queries and those of the Zed extension are valid for the grammar', async () => {
        const files = [
            path.join(GRAMMAR_DIR, 'queries', 'highlights.scm'),
            ...['highlights', 'brackets', 'indents', 'outline'].map((q) => path.join(ZED_LANGUAGE, `${q}.scm`)),
        ];
        for (const file of files) new Query(language, await readFile(file, 'utf8')).delete();
    });

    test("the Zed extension highlights like the grammar, with Zed's capture for context names", async () => {
        const grammar = await readFile(path.join(GRAMMAR_DIR, 'queries', 'highlights.scm'), 'utf8');
        expect(await readFile(path.join(ZED_LANGUAGE, 'highlights.scm'), 'utf8')).toBe(grammar.replace('@module', '@type'));
    });
});
