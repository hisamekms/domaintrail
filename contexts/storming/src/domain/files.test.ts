import { describe, expect, test } from 'bun:test';
import { isStormingFile } from './files.js';

describe('Event Storming files', () => {
    test('a .dtes source is a storming, every other source is a .dt source', () => {
        expect(['a.dtes', 'a.dt', 'dtes', 'a.dtes.bak'].map(isStormingFile)).toEqual([true, false, false, false]);
    });
});
