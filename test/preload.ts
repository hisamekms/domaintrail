// Every test process keeps what dt keeps per user in directories of its own, never the user's: its approvals of
// security-relevant settings (`dt open`, `dt collab`, `dt agent`: apps/dt/src/cli/trust.ts, below XDG_CONFIG_HOME,
// ~/.config/domaintrail/trust.json otherwise) and the workspaces' state and cache (@domaintrail/workspace's
// state-dirs.ts: below DOMAINTRAIL_STATE_DIR and XDG_CACHE_HOME, ~/.local/state/domaintrail and ~/.cache/domaintrail
// otherwise). The processes the tests start inherit them.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const base = mkdtempSync(path.join(tmpdir(), 'domaintrail-test-home-'));
const dir = (name: string): string => {
    const d = path.join(base, name);
    mkdirSync(d, { mode: 0o700 });
    return d;
};
process.env.XDG_CONFIG_HOME = dir('config');
process.env.XDG_STATE_HOME = dir('state');
process.env.XDG_CACHE_HOME = dir('cache');
process.env.XDG_RUNTIME_DIR = dir('runtime');
process.env.DOMAINTRAIL_STATE_DIR = path.join(process.env.XDG_STATE_HOME, 'domaintrail');
