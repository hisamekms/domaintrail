// Mentions of people (ADR 0026, amendment "mentions of people"): the body's tokens as the page, the prompt and the
// classifier read them (the use case's checks and the route: test/session-people-mentions.test.ts).
import { describe, expect, test } from 'bun:test';
import { parseBody, peopleAsNames, plainBody, renumberTokens, tokenName, tokensIn } from './body.js';

describe("a body's tokens", () => {
    const counts = { targets: 2, people: 1 };
    test('`#name[n]` is an element, `@name[n]` too (as written before), `@name[pN]` a person; the rest is text', () => {
        expect(parseBody('#注文[1] と @顧客[2] を @佐藤[p1] に <b>確認</b> #謎[3] @謎[p2] #人[p1] a@b[1]', counts)).toEqual([
            { kind: 'element', name: '注文', index: 0 },
            { kind: 'text', text: ' と ' },
            { kind: 'element', name: '顧客', index: 1 },
            { kind: 'text', text: ' を ' },
            { kind: 'person', name: '佐藤', index: 0 },
            // past the request's targets and people, and a person written with `#`: text as it was written
            { kind: 'text', text: ' に <b>確認</b> #謎[3] @謎[p2] #人[p1] a' },
            { kind: 'element', name: 'b', index: 0 },
        ]);
        // a Japanese IME's full-width signs
        expect(parseBody('＃注文[1]＠佐藤[p1]', counts)).toEqual([
            { kind: 'element', name: '注文', index: 0 },
            { kind: 'person', name: '佐藤', index: 0 },
        ]);
    });

    test('on one line: `#name` and `@name`; bare (for the classifier): the names alone', () => {
        expect(plainBody('#注文[1] を @佐藤[p1] と @顧客[2] で #謎[3]', counts)).toBe('#注文 を @佐藤 と #顧客 で #謎[3]');
        expect(plainBody('#注文[1] を @佐藤[p1] が見る', undefined, true)).toBe('注文 を 佐藤 が見る');
    });

    test('the prompt reads a person as a plain `@name` and keeps the elements numbered', () => {
        expect(peopleAsNames('#注文[1] を @佐藤[p1] と @顧客[2]')).toBe('#注文[1] を @佐藤 と @顧客[2]');
    });

    test('the tokens of a text, renumbered by kind; a name made fit for a token', () => {
        expect(tokensIn('#a[1] @b[p2] @c[3]')).toEqual([
            { kind: 'element', name: 'a', index: 0 },
            { kind: 'person', name: 'b', index: 1 },
            { kind: 'element', name: 'c', index: 2 },
        ]);
        expect(renumberTokens('#a[1] @b[p2] @c[3]', 'person', (i) => (i === 1 ? 0 : undefined))).toBe('#a[1] @b[p1] @c[3]');
        expect(renumberTokens('#a[1] @b[p2] @c[3]', 'element', (i) => (i === 0 ? undefined : i - 1))).toBe('a @b[p2] @c[2]');
        expect(tokenName('佐藤 #1 @x [y]')).toBe('佐藤1xy');
        expect(tokenName('  ')).toBe('?');
    });
});
