// Every test process keeps its approvals of security-relevant settings (`dt open`, `dt collab`, `dt agent`:
// apps/dt/src/cli/trust.ts) in a directory of its own, never in the user's ~/.config/domaintrail/trust.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'domaintrail-test-config-'));
