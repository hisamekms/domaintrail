import { runDt } from '../src/composition/cli.js';

process.exitCode = await runDt(process.argv.slice(2));
