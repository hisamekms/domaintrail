import { runCli } from '../src/presentation/cli/main.js';

process.exitCode = await runCli(process.argv.slice(2));
