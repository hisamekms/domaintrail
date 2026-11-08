import { describe, expect, test } from 'bun:test';
import { attachmentName } from './download';

describe('the name of the downloaded sources', () => {
    test('the UTF-8 filename* first, as the server sends it; else the plain filename', () => {
        expect(attachmentName(`attachment; filename="sources.zip"; filename*=UTF-8''${encodeURIComponent('販売店-sources.zip')}`)).toBe('販売店-sources.zip');
        expect(attachmentName('attachment; filename="shop-sources.zip"')).toBe('shop-sources.zip');
        expect(attachmentName('attachment; filename=shop-sources.zip')).toBe('shop-sources.zip');
        expect(attachmentName('attachment; filename="a.zip"; filename*=UTF-8\'\'%E0%A4%A')).toBe('a.zip');
        expect(attachmentName(null)).toBeUndefined();
        expect(attachmentName('attachment')).toBeUndefined();
    });
});
