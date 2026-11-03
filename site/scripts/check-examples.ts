// `bun run examples:check`: each example workspace of the guide passes `dt check` with no warning and is formatted
// (`dt fmt --check`). The root's tests check the same (test/site-examples.test.ts).
import { join } from 'node:path';
import { EXAMPLES, PHASES, dt, exampleDirs } from './dt.ts';

let failed = 0;
const dirs = exampleDirs();
for (const phase of PHASES) {
    if (dirs.includes(phase)) continue;
    console.error(`missing: examples/${phase}`);
    failed++;
}
for (const dir of dirs) {
    const root = join(EXAMPLES, dir);
    const check = dt(['-r', root, 'check']);
    const fmt = dt(['-r', root, 'fmt', '--check']);
    const clean = check.code === 0 && / 0 warning\(s\)/.test(check.out) && fmt.code === 0;
    console.log(`${clean ? 'ok  ' : 'FAIL'} examples/${dir}: ${check.out.trim().split('\n').at(-1)}`);
    if (!clean) {
        failed++;
        console.log(check.out + fmt.out);
    }
}
if (failed > 0) {
    console.error(`${failed} example(s) failed`);
    process.exit(1);
}
