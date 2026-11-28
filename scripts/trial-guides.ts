// Renders the `dt guide` of each arm of the Phase 2 AI trial from one template (docs/guide.md, the A0 guide) and the
// parameters in docs/plans/formal-verification/trial/guide-arms.json, and checks them: each parameter applies exactly
// once and keeps its line count, an arm differs from A0 only on the lines of its parameters, and the guide's `dt`
// examples check clean under that arm. The guides are frozen per run: they go to the run's directory with a manifest of
// hashes, not into the repository. Run: `bun scripts/trial-guides.ts <out-dir>`.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');
const TRIAL = path.join(ROOT, 'docs', 'plans', 'formal-verification', 'trial');

interface Parameter {
    readonly section: string;
    readonly from: string;
    readonly to: string;
}
interface Arms {
    readonly version: string;
    readonly template: string;
    readonly arms: Record<'A0' | 'M2' | 'M3' | 'Q2', Parameter[]>;
}

export type Arm = keyof Arms['arms'];
const ARMS: readonly Arm[] = ['A0', 'M2', 'M3', 'Q2'];

const isParameter = (p: unknown): p is Parameter =>
    typeof p === 'object' && p !== null && 'section' in p && 'from' in p && 'to' in p && [p.section, p.from, p.to].every((x) => typeof x === 'string');

/** guide-arms.json, checked: a version, the template's path, and the parameters of each of the four arms. */
function parseArms(v: unknown): Arms {
    if (typeof v !== 'object' || v === null || !('version' in v) || !('template' in v) || !('arms' in v))
        throw new Error('guide-arms.json: version, template and arms');
    const { version, template, arms } = v;
    if (typeof version !== 'string' || typeof template !== 'string' || typeof arms !== 'object' || arms === null) throw new Error('guide-arms.json: bad shape');
    const table: Record<string, unknown> = { ...arms };
    const of = (arm: Arm): Parameter[] => {
        const list = table[arm];
        if (!Array.isArray(list) || !list.every(isParameter)) throw new Error(`guide-arms.json: the parameters of ${arm}`);
        return list;
    };
    return { version, template, arms: { A0: of('A0'), M2: of('M2'), M3: of('M3'), Q2: of('Q2') } };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The rendered guide of an arm and the 1-based lines its parameters changed. */
function render(template: string, params: readonly Parameter[]): { text: string; lines: number[] } {
    let text = template;
    for (const p of params) {
        const count = text.split(p.from).length - 1;
        if (count !== 1) throw new Error(`parameter (${p.section}) occurs ${count} times in the template, not once`);
        if (p.from.split('\n').length !== p.to.split('\n').length) throw new Error(`parameter (${p.section}) changes the line count`);
        text = text.replace(p.from, p.to);
    }
    const a = template.split('\n');
    const b = text.split('\n');
    const lines = a.flatMap((line, i) => (line === b[i] ? [] : [i + 1]));
    // every changed line lies in a parameter's span
    const spans = params.map((p) => {
        const start = template.slice(0, template.indexOf(p.from)).split('\n').length;
        return [start, start + p.from.split('\n').length - 1] as const;
    });
    for (const l of lines) if (!spans.some(([s, e]) => l >= s && l <= e)) throw new Error(`line ${l} differs outside the parameters`);
    return { text, lines };
}

/** The `dt` blocks of a guide as the files of one workspace, named by their first line (`// sales/order.dt`). */
function workspace(markdown: string): { path: string; text: string }[] {
    return [...markdown.matchAll(/^```dt\n([\s\S]*?)^```/gm)].flatMap((m) => {
        const name = /^\/\/ (\S+\.dt)\n/.exec(m[1]!)?.[1];
        return name ? [{ path: name, text: m[1]! }] : [];
    });
}

export interface ArmGuide {
    readonly arm: Arm;
    readonly text: string;
    readonly sha256: string;
    readonly changedLines: number[];
    readonly sections: string[];
}

/** Every arm's guide, checked; and the manifest that records the template, the parameters and each guide. */
export async function renderArmGuides(): Promise<{ guides: ArmGuide[]; manifest: unknown }> {
    const armsText = await readFile(path.join(TRIAL, 'guide-arms.json'), 'utf8');
    const arms = parseArms(JSON.parse(armsText));
    const template = await readFile(path.join(ROOT, arms.template), 'utf8');
    const { analyzeDomain } = await import('@domaintrail/modeling');
    const before = process.env['DOMAINTRAIL_TRIAL_ARM'];
    const guides: ArmGuide[] = [];
    try {
        for (const arm of ARMS) {
            const params = arms.arms[arm];
            const { text, lines } = render(template, params);
            process.env['DOMAINTRAIL_TRIAL_ARM'] = arm;
            const a = await analyzeDomain(workspace(text));
            const problems = a.diagnostics.filter((d) => d.severity !== 'info');
            if (problems.length)
                throw new Error(
                    `the ${arm} guide's examples do not check:\n${problems.map((d) => `${d.file}:${d.start.line} ${d.code} ${d.message}`).join('\n')}`,
                );
            guides.push({ arm, text, sha256: sha256(text), changedLines: lines, sections: params.map((p) => p.section) });
        }
    } finally {
        if (before === undefined) delete process.env['DOMAINTRAIL_TRIAL_ARM'];
        else process.env['DOMAINTRAIL_TRIAL_ARM'] = before;
    }
    const manifest = {
        templateVersion: arms.version,
        template: { path: arms.template, sha256: sha256(template) },
        parameters: { path: 'docs/plans/formal-verification/trial/guide-arms.json', sha256: sha256(armsText) },
        arms: Object.fromEntries(guides.map((g) => [g.arm, { guide: `${g.arm}.md`, sha256: g.sha256, changedLines: g.changedLines, sections: g.sections }])),
    };
    return { guides, manifest };
}

if (import.meta.main) {
    const out = process.argv[2];
    if (!out) throw new Error('usage: bun scripts/trial-guides.ts <out-dir>');
    const { guides, manifest } = await renderArmGuides();
    await mkdir(out, { recursive: true });
    for (const g of guides) {
        await writeFile(path.join(out, `${g.arm}.md`), g.text);
        console.log(`${g.arm}: ${g.changedLines.length} line(s) differ from A0, sha256 ${g.sha256.slice(0, 12)}`);
    }
    await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
