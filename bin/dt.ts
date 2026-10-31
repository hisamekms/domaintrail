import { runDt } from '@domaintrail/composition/cli';

process.exitCode = await runDt(process.argv.slice(2));
