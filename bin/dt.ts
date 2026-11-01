import { runDt } from '@domaintrail/dt';

process.exitCode = await runDt(process.argv.slice(2));
