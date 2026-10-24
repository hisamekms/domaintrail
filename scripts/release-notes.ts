// Prints the notes of the GitHub Release of a version: its section of CHANGELOG.md, then its section of
// CHANGELOG.ja.md folded in <details>. Fails when either file has no section for the version, so the Release workflow
// runs it before publishing to npm. Also for releases made by hand: `bun scripts/release-notes.ts 0.4.0`.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export const ROOT = path.join(import.meta.dir, '..');
export const CHANGELOGS = { en: 'CHANGELOG.md', ja: 'CHANGELOG.ja.md' } as const;
const REPOSITORY = 'https://github.com/hisamekms/domaintrail';

export interface Section {
    /** `0.5.0`, or `Unreleased`. */
    version: string;
    /** `2026-10-24`; none for `Unreleased`. */
    date?: string;
    /** The text under the `## [version]` heading, trimmed. */
    body: string;
}

/** The `## [version]` sections of a changelog, in order; the link references at the end are not part of the last. */
export function sections(changelog: string): Section[] {
    const text = changelog.replace(/^\[[^\]]+\]: .*$/gm, '');
    return [...text.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map((m) => ({
        version: m[1],
        date: m[2],
        body: m[3].trim(),
    }));
}

/** The `### ` headings of a section's body, in order. */
export const subsections = (body: string): string[] => body.replace(/^```[\s\S]*?^```/gm, '').match(/^### .+$/gm) ?? [];

const CJK = /[　-ヿ一-鿿＀-￯]/;

/**
 * The changelogs' text for a release body, outside code blocks (the odd parts of a split on fences):
 * - relative links (`docs/x.md`) point to the files at the version's tag (`main` for Unreleased), since a release
 *   body has no base path;
 * - the lines wrapped by hand are joined, since GitHub shows every line break of a release body; without a space
 *   next to a Japanese character.
 */
const forRelease = (body: string, version: string): string => {
    const ref = version === 'Unreleased' ? 'main' : `v${version}`;
    const unwrap = (text: string): string => {
        const lines: string[] = [];
        for (const line of text.split('\n')) {
            const last = (lines.at(-1) ?? '').trimEnd();
            const continues = last.trim() && !last.trimStart().startsWith('#') && line.trim() && !/^\s*([-*] |\d+\. |#|```|<)/.test(line);
            if (!continues) lines.push(line);
            else lines[lines.length - 1] = last + (CJK.test(last.slice(-1)) || CJK.test(line.trim()[0]) ? '' : ' ') + line.trim();
        }
        return lines.join('\n');
    };
    return body
        .split(/(^ *```[\s\S]*?^ *```)/m)
        .map((part, i) =>
            i % 2 ? part : unwrap(part.replace(/\]\((?![a-z]+:|#)([^)\s]+)\)/g, (_, target: string) => `](${REPOSITORY}/blob/${ref}/${target})`)),
        )
        .join('');
};

/** The release notes of `version` from the two changelogs' texts; throws when either has no section for it. */
export function releaseNotes(version: string, changelogs: { en: string; ja: string }): string {
    const find = (lang: 'en' | 'ja') => {
        const section = sections(changelogs[lang]).find((s) => s.version === version);
        if (!section) throw new Error(`${CHANGELOGS[lang]} has no section for ${version}: add "## [${version}] - YYYY-MM-DD".`);
        if (!section.body) throw new Error(`The section for ${version} in ${CHANGELOGS[lang]} is empty.`);
        return forRelease(section.body, version);
    };
    const en = find('en');
    const ja = find('ja');
    return `${en}\n\n<details>\n<summary>日本語</summary>\n\n${ja}\n\n</details>\n`;
}

export async function readChangelogs(): Promise<{ en: string; ja: string }> {
    const [en, ja] = await Promise.all([readFile(path.join(ROOT, CHANGELOGS.en), 'utf8'), readFile(path.join(ROOT, CHANGELOGS.ja), 'utf8')]);
    return { en, ja };
}

if (import.meta.main) {
    const arg = process.argv[2];
    if (!arg) {
        console.error('usage: bun scripts/release-notes.ts <version>   (e.g. 0.5.0 or v0.5.0)');
        process.exit(2);
    }
    try {
        process.stdout.write(releaseNotes(arg.replace(/^v/, ''), await readChangelogs()));
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
}
