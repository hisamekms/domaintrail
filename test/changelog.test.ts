import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ROOT, readChangelogs, releaseNotes, sections, subsections } from '../scripts/release-notes.js';

const changelogs = await readChangelogs();
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string; files: string[] };
const en = sections(changelogs.en);
const ja = sections(changelogs.ja);

/** The `###` headings of the Japanese changelog, and the English ones they stand for. */
const JA_SECTIONS: Record<string, string> = {
    '### 追加': '### Added',
    '### 変更': '### Changed',
    '### 削除': '### Removed',
    '### 修正': '### Fixed',
    '### アップグレード手順': '### Upgrading',
};

/** The versions of the release tags (`v0.2.0` → `0.2.0`); none in a clone without tags. */
const tagged = (): string[] => {
    const r = Bun.spawnSync(['git', 'tag', '--list', 'v*.*.*'], { cwd: ROOT });
    return r.exitCode === 0
        ? r.stdout
              .toString()
              .split('\n')
              .filter(Boolean)
              .map((t) => t.slice(1))
        : [];
};

const semver = (v: string): number[] => v.split('.').map(Number);
const newer = (a: string, b: string): boolean => {
    const [x, y] = [semver(a), semver(b)];
    const i = x.findIndex((n, j) => n !== y[j]);
    return i >= 0 && x[i] > y[i];
};

describe('changelogs', () => {
    test('list the released versions from the newest, each with a date (no Unreleased section)', () => {
        const versions = en;
        expect(versions.length).toBeGreaterThanOrEqual(5);
        for (const s of versions) {
            expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
            expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        for (let i = 1; i < versions.length; i++) expect(newer(versions[i - 1].version, versions[i].version)).toBe(true);
    });

    test('the Japanese one has the versions, dates and ### sections of the English one, in the same order', () => {
        const outline = (ss: typeof en, names: Record<string, string>) =>
            ss.map((s) => ({ version: s.version, date: s.date, sections: subsections(s.body).map((h) => names[h] ?? h) }));
        expect(outline(ja, JA_SECTIONS)).toEqual(outline(en, {}));
    });

    test('use only the sections of Keep a Changelog and Upgrading, with Japanese headings in the Japanese one', () => {
        for (const s of en) for (const h of subsections(s.body)) expect(Object.values(JA_SECTIONS)).toContain(h);
        for (const s of ja) for (const h of subsections(s.body)) expect(Object.keys(JA_SECTIONS)).toContain(h);
    });

    test('have a section for the version in package.json and for every release tag', () => {
        for (const version of [pkg.version, '0.1.0', ...tagged()]) {
            expect(en.map((s) => s.version)).toContain(version);
            expect(ja.map((s) => s.version)).toContain(version);
        }
    });

    test('have a link reference for every section', () => {
        for (const text of [changelogs.en, changelogs.ja])
            for (const s of en)
                expect(text).toMatch(new RegExp(`^\\[${s.version.replaceAll('.', '\\.')}\\]: https://github\\.com/hisamekms/domaintrail/`, 'm'));
    });

    test('are shipped in the package', () => {
        expect(pkg.files).toContain('CHANGELOG.md');
        expect(pkg.files).toContain('CHANGELOG.ja.md');
    });
});

describe('release notes', () => {
    test('hold the English section and the Japanese one folded under 日本語', () => {
        const notes = releaseNotes('0.5.0', changelogs);
        const [english, japanese] = notes.split('<details>');
        expect(english).toContain('### Upgrading');
        expect(english).toContain('respectGitignore');
        expect(english).not.toMatch(/[぀-ヿ]/);
        expect(japanese).toStartWith('\n<summary>日本語</summary>\n');
        expect(japanese).toContain('ワークスペース');
        expect(japanese.trimEnd()).toEndWith('</details>');
        // only the version's own section
        expect(notes).not.toContain('## [');
        expect(notes).not.toContain('`requires`');
    });

    test('join the lines wrapped by hand, outside code blocks, and make relative links absolute', () => {
        const notes = releaseNotes('0.4.0', changelogs);
        expect(notes).toContain('Change the model first, then generate, then the code. The full rules are in');
        expect(notes).toContain('   create command place(id: OrderId, customer: CustomerId) -> Draft // after\n');
        const linked = (text: string) => `## [9.9.9] - 2026-12-31\n\n### Added\n\n- ${text} [Getting started](docs/getting-started.md).\n`;
        const withLinks = releaseNotes('9.9.9', { en: linked('See'), ja: linked('参照:') });
        expect(withLinks).toContain('](https://github.com/hisamekms/domaintrail/blob/v9.9.9/docs/getting-started.md)');
        expect(withLinks).not.toContain('](docs/');
    });

    test('fail when either changelog has no section for the version', () => {
        expect(() => releaseNotes('9.9.9', changelogs)).toThrow('CHANGELOG.md has no section for 9.9.9');
        const withoutJa = { en: changelogs.en, ja: changelogs.ja.replace('## [0.5.0]', '## [0.5.0-removed]') };
        expect(() => releaseNotes('0.5.0', withoutJa)).toThrow('CHANGELOG.ja.md has no section for 0.5.0');
    });

    test('the script prints them for a version with or without the v, and exits 1 for a missing one', () => {
        const run = (arg: string) => Bun.spawnSync([process.execPath, path.join(ROOT, 'scripts', 'release-notes.ts'), arg]);
        const ok = run('v0.5.0');
        expect(ok.exitCode).toBe(0);
        expect(ok.stdout.toString()).toBe(releaseNotes('0.5.0', changelogs));
        const missing = run('9.9.9');
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr.toString()).toContain('has no section for 9.9.9');
    });
});
