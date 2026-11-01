import { runDt } from '@domaintrail/composition';

process.exitCode = await runDt(process.argv.slice(2));
