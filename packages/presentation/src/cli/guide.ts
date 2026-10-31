import { didYouMean } from '../../modeling/core/suggest.js';

/** A section of the guide, named by the `<!-- topic: name -->` line above its heading. */
export interface GuideTopic {
    name: string;
    /** The heading's text, without the `#`s. */
    title: string;
    /** 2 for `##`, 3 for `###`. */
    level: number;
    /** The heading and its text up to the next heading of the same or a higher level, without topic lines. */
    text: string;
    /** Whether a deeper topic follows inside it (a `##` with `###` sections). */
    parent: boolean;
}

export interface Guide {
    /** The text before the first topic: the title and what the guide is. */
    intro: string;
    topics: GuideTopic[];
}

const TOPIC = /^<!-- topic: ([a-z0-9-]+) -->$/;

/** Splits the guide into its topics. A topic line must be directly above a `##` or `###` heading. */
export function parseGuide(markdown: string): Guide {
    const lines = markdown.split('\n');
    const starts: { name: string; line: number; level: number; title: string }[] = [];
    let fenced = false;
    for (const [i, line] of lines.entries()) {
        if (line.startsWith('```')) fenced = !fenced;
        const name = fenced ? undefined : TOPIC.exec(line)?.[1];
        if (!name) continue;
        const heading = /^(#{2,3}) (.+)$/.exec(lines[i + 1] ?? '');
        if (!heading) throw new Error(`guide: the topic line '${name}' is not followed by a ## or ### heading`);
        starts.push({ name, line: i, level: heading[1].length, title: heading[2] });
    }
    const body = (from: number, to: number) =>
        lines
            .slice(from, to)
            .filter((l) => !TOPIC.test(l))
            .join('\n')
            .trim();
    const topics = starts.map((s, k) => {
        const end = starts.slice(k + 1).find((t) => t.level <= s.level)?.line ?? lines.length;
        return { name: s.name, title: s.title, level: s.level, text: body(s.line, end), parent: starts[k + 1]?.level > s.level };
    });
    return { intro: body(0, starts[0]?.line ?? lines.length), topics };
}

/** The list of topics as printed by `dt guide`: one line each, `###` topics indented under their `##`. */
export function topicList(guide: Guide): string[] {
    const width = Math.max(...guide.topics.map((t) => t.name.length + 2 * (t.level - 2)));
    return guide.topics.map((t) => {
        const name = '  '.repeat(t.level - 1) + t.name;
        return `${name.padEnd(width + 2)}  ${t.title.replace(/`/g, '')}${t.parent ? ' (with its indented topics)' : ''}`;
    });
}

/** What `dt guide` prints: the intro, the quick reference and the list of topics. */
export function quickReference(guide: Guide): string {
    const quick = guide.topics.find((t) => t.name === 'quick');
    return [
        guide.intro,
        quick?.text,
        '## Topics',
        '`dt guide <topic>` prints one, `dt guide <rule>` one rule (`dt guide M010`), `dt guide --all` the whole guide.',
        ['```text', ...topicList(guide), '```'].join('\n'),
    ]
        .filter((part) => part !== undefined)
        .join('\n\n');
}

/**
 * The row of a rule in the table of the `rules` topic, with the table's header, and the topics that mention the
 * rule (leaf topics only, not the quick reference or the rules), or undefined for an unknown rule.
 */
export function ruleText(guide: Guide, code: string): string | undefined {
    const rules = guide.topics.find((t) => t.name === 'rules');
    const table = rules?.text.split('\n').filter((l) => l.startsWith('|')) ?? [];
    const row = table.find((l) => l.startsWith(`| ${code.toUpperCase()} |`));
    if (!row) return undefined;
    const word = new RegExp(`\\b${code.toUpperCase()}\\b`);
    const seeAlso = guide.topics.filter((t) => !t.parent && t.name !== 'rules' && t.name !== 'quick' && word.test(t.text));
    return [
        `## Rule ${code.toUpperCase()}`,
        [...table.slice(0, 2), row].join('\n'),
        ...(seeAlso.length ? [`Explained in: ${seeAlso.map((t) => `\`dt guide ${t.name}\``).join(', ')}.`] : []),
    ].join('\n\n');
}

/** What `dt guide <name>` prints: a topic or a rule; an unknown name gets an error with suggestions. */
export function guideTopic(guide: Guide, name: string): { text: string } | { error: string } {
    const topic = guide.topics.find((t) => t.name === name.toLowerCase());
    if (topic) return { text: topic.text };
    const rule = ruleText(guide, name);
    if (rule) return { text: rule };
    const names = guide.topics.map((t) => t.name);
    const hint = didYouMean(name, names);
    return { error: `Unknown topic '${name}'${hint ? `; ${hint}` : '.'} Topics: ${names.join(', ')} (or a rule code, e.g. M010).` };
}
