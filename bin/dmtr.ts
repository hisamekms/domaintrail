import { runCli } from '../src/cli/main.js';

process.exitCode = await runCli(process.argv.slice(2));
