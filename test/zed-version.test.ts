import { describe, expect, test } from 'bun:test';
import { ZED_VERSION_SITES, packageVersion, versionAt } from '../scripts/zed-version.js';

describe('the Zed extension version', () => {
    for (const site of ZED_VERSION_SITES) {
        test(`follows the package in ${site.file}`, async () => {
            expect(await versionAt(site)).toBe(await packageVersion());
        });
    }
});
