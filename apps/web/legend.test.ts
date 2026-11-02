import { describe, expect, test } from 'bun:test';
import { MESSAGES } from './i18n';
import { STORMING_LEGEND_KINDS } from './legend';

describe('the storming legend key', () => {
    test('names every kind of note but the timeline, which is drawn as its arrows', () => {
        const kinds = Object.keys(MESSAGES.ja.esKinds).filter((k) => k !== 'timeline');
        expect(STORMING_LEGEND_KINDS.map(String).sort()).toEqual(kinds.sort());
    });
});
