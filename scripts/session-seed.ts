// `bun run session:seed`: a collaboration session filled with every display pattern of the chat, for review, without
// Claude Code. It copies examples/shop into a scratch directory, starts `dt collab --no-agent` there (the built CLI), signs
// in named participants, plays the chosen scenarios through the session's real APIs with a scripted agent, stops that
// agent and leaves the session server running in the foreground (Ctrl+C stops it). See docs/dev-session-seed.md.
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SCENARIO_NAMES, scenariosOf } from './session-seed/scenarios.js';
import { seed } from './session-seed/seed.js';

const ROOT = path.join(import.meta.dir, '..');
const USAGE = `Usage: bun run session:seed [options]

  --scenario <names>   ${SCENARIO_NAMES.join(', ')} or all (repeatable, or a comma list; default: all)
  --dir <dir>          the scratch workspace to make (default: $TMPDIR/dt-session-seed)
  --workspace <dir>    the workspace copied into it (default: examples/shop; the scenarios name its elements)
  --reset              wipe --dir first when an earlier seed made it
  --port <port>        the Live View's port (default: 4321)
  --no-classifier      leave the message classifier off (no 依頼 / 会話 tags)
  --leave-queued       leave one run queued at the end, for the next subscriber
  --leave-running      leave one run running (the seed's agent holds it) and two queued behind it
  --exit               stop the session server once seeded instead of leaving it running`;

async function main(): Promise<number> {
    const { values } = parseArgs({
        options: {
            scenario: { type: 'string', multiple: true },
            dir: { type: 'string' },
            workspace: { type: 'string' },
            reset: { type: 'boolean' },
            port: { type: 'string' },
            'no-classifier': { type: 'boolean' },
            'leave-queued': { type: 'boolean' },
            'leave-running': { type: 'boolean' },
            exit: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
        strict: true,
    });
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    const scenarios = scenariosOf(values.scenario ?? ['all']);
    const port = Number(values.port ?? 4321);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Not a port: ${values.port}`);
    const cli = path.join(ROOT, 'dist', 'dt.js');
    if (!existsSync(cli) || !existsSync(path.join(ROOT, 'dist', 'web'))) throw new Error('dist/ is not built: run `bun run build` first.');

    const seeded = await seed({
        scenarios,
        source: path.resolve(values.workspace ?? path.join(ROOT, 'examples', 'shop')),
        dir: path.resolve(values.dir ?? path.join(tmpdir(), 'dt-session-seed')),
        reset: values.reset ?? false,
        port,
        classifier: !values['no-classifier'],
        leaveQueued: values['leave-queued'] ?? false,
        leaveRunning: values['leave-running'] ?? false,
        dt: { command: 'node', args: [cli] },
        log: (line) => console.log(`[seed] ${line}`),
        serverLog: (line) => console.log(`[dt] ${line}`),
    });
    const { state } = seeded;
    const facilitator = seeded.participants.find((p) => p.me.participant.role === 'facilitator');
    console.log(`
Seeded ${scenarios.join(', ')}: ${state.requests.length} messages, ${state.runs.length} runs, ${state.marks.length} marks.

  Workspace:   ${seeded.dir}   (git diff shows what the runs changed)
  Live View:   ${seeded.url}
  Facilitator: open the Live View, join with any name, then open (single use, 10 minutes):
               ${seeded.facilitatorLink}
               You then hold the role of ${facilitator?.name ?? 'the facilitator'}: the facilitator's messages and reactions show as 「あなた」.
               Another link: node ${path.relative(process.cwd(), path.join(ROOT, 'dist', 'dt.js'))} -r ${seeded.dir} collab link
  Participant: a private window, the same URL, any name (a new participant). The seeded ones
               (${seeded.participants.map((p) => p.name).join(', ')}) and their cookies are in ${seeded.seedFile}.
  Agent:       ${values['leave-running'] ? "the seed's agent holds the run left running and the queued ones (cancel them to move on)" : "the seed's agent is stopped"}. For real runs: node ${path.relative(process.cwd(), path.join(ROOT, 'dist', 'dt.js'))} -r ${seeded.dir} agent
`);
    if (values.exit) {
        await seeded.stop();
        return 0;
    }
    console.log('The session server runs until Ctrl+C.');
    let stopping = false;
    const interrupted = (): void => {
        if (stopping) return;
        stopping = true;
        void seeded.stop();
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    const code = await seeded.exited;
    await seeded.stop();
    return code ?? 0;
}

main().then(
    (code) => process.exit(code),
    (e: unknown) => {
        console.error(`session-seed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    },
);
