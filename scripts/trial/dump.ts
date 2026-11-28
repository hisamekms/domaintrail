// The Typed Model and the Semantic IR of the `.dt` files below a directory, as JSON on stdout, read under the arm in
// DOMAINTRAIL_TRIAL_ARM (scripts/trial/score.ts normalizes them for the reviewers).
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeDomain, semanticIROf } from '@domaintrail/modeling';

const root = process.argv[2] ?? '.';
const files: { path: string; text: string }[] = [];
const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'gen') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.dt')) files.push({ path: path.relative(root, p), text: await readFile(p, 'utf8') });
    }
};
await walk(root);
const a = await analyzeDomain(files);
console.log(JSON.stringify({ model: a.model ?? null, semanticIR: a.model ? semanticIROf(a) : null }));
