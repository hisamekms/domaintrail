// Seeds a collaboration session for review (scripts/session-seed.ts): a scratch copy of examples/shop, `dt collab
// --no-agent` from the built CLI (a child process: its outbox, WebSocket, classifier and agent API are the real ones),
// named participants signed in with their own cookies (one of them made the facilitator with the start's link), the
// seed's agent (the real subscriber with a scripted runner), and the scenarios played through the session API as pages
// play them. The agent is stopped once the scenarios are done, so that a real `dt agent` can take over —
// unless it is to leave a run running, which it then holds until the server stops.
import { plainBody } from '@domaintrail/collaboration';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { DtCommand } from '@domaintrail/agent';
import type { AnswerBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { startMockClassifier, type MockClassifier, type ReadsAs } from './classifier.js';
import { sessionClient, type Participant, type SessionClient } from './client.js';
import { startFakeAgent, type FakeAgent, type Step } from './fake-agent.js';
import { SCENARIOS, type ScenarioName } from './scenarios.js';
import { copyWorkspace, prepareDir, SEED_TOKEN_ENV, writeSeedFile } from './workspace.js';

export type RunJson = SessionStateBody['runs'][number];
export type RequestJson = SessionStateBody['requests'][number];
type Target = NonNullable<Parameters<SessionClient['send']>[1]['targets']>[number]['target'];

/** The seeded people: the facilitator and four participants. */
export const PEOPLE = { facilitator: 'ooyama_F', sato: '佐藤', suzuki: '鈴木', tanaka: '田中', takahashi: '高橋' } as const;
export type Person = keyof typeof PEOPLE;

/** The note a page writes when the facilitator picks another alternative of an assumption (`alternativeNote` of apps/web/i18n.tsx, ja). */
export const alternativeNote = (assumption: string, alternative: string): string =>
    `前提「${assumption}」は採らず、「${alternative}」としてやり直してください。`;

/** The facilitator's message of a revert, as the page writes it (`revertBody` of apps/web/i18n.tsx, ja). */
export const revertBody = (name: string): string => `${name}の変更を打ち消す`;

/** The run states a run does not leave. */
const ENDED = new Set(['Completed', 'NeedsClarification', 'Declined', 'Failed', 'Cancelled']);
/** How long a run of the seed's agent may take (it runs `dt fmt` and `dt check`). */
const RUN_TIMEOUT_MS = 60_000;

/** What a scenario is written with: the people, their messages, the facilitator's runs, votes and reactions. */
export interface Ctx {
    readonly root: string;
    readonly api: SessionClient;
    readonly people: Readonly<Record<Person, Participant>>;
    /** A `.dt` element, state (`Sales.Order#Draft`) or command (`Sales.Order:confirm`) as a target. */
    dt(element: string, label: string): TargetSpec;
    /** A storming element as a target. */
    es(storming: string, local: string, label: string): TargetSpec;
    /** An event's occurrence in a timeline (the step path: `0`, `2.1`) as a target. */
    occurrence(storming: string, timeline: string, eventName: string, step: string, label: string): TargetSpec;
    /** `who` sends a message; `reads`: what the mock classifier answers for it (default: guessed from its words). */
    /** `mentions`: the people `@name[pN]` in the body names, in order (the N-th from 1). `replyTo`: a run or a message it replies to. */
    say(
        who: Person,
        body: string,
        options?: { targets?: readonly TargetSpec[]; reads?: ReadsAs; replyTo?: RunJson | RequestJson; mentions?: readonly Person[] },
    ): Promise<RequestJson>;
    /**
     * The facilitator applies messages as one run that the agent plays as `step`; resolves once the run ended. One
     * message without a note goes as the page's 「AI に送る」 does (ADR 0030): addressed to the AI, its triage decides a
     * change request (the classifier, else the seed's answerer) and queues the run. Several messages, or a note, are
     * one run queued at once (the runs route the page still uses for a run with a comment).
     */
    apply(requests: readonly RequestJson[], step: Step, options?: { note?: string }): Promise<RunJson>;
    /** The facilitator answers a run's questions: its requests queued again with the answer, played as `step`. */
    answer(run: RunJson, answer: AnswerBody, step: Step): Promise<RunJson>;
    /** The facilitator picks another alternative of an assumption of a completed run, played as `step`. */
    pickAlternative(run: RunJson, assumption: number, alternative: string, step: Step): Promise<RunJson>;
    /**
     * The facilitator reverts the unit of work of `run`, named `name` (the chat's 「〈name〉の変更を打ち消す」): queued, and
     * — the queue being empty — done mechanically by the server at once, or — when `step` is given, which the revert
     * must then need — left to the agent and played as `step`.
     */
    revert(run: RunJson, name: string, step?: Step): Promise<RunJson>;
    /** The facilitator approves an assumption of a completed run as it is: recorded, nothing queued. */
    approveAssumption(run: RunJson, assumption: number): Promise<void>;
    /** The facilitator applies messages as a run the agent works on until the facilitator cancels it. */
    cancelWhileRunning(requests: readonly RequestJson[]): Promise<RunJson>;
    /** `who` votes for a question's option. */
    voteOption(who: Person, run: RunJson, question: string, option: string): Promise<void>;
    /** `who` votes for an assumption's alternative, or (none) for keeping it as it is. */
    voteAssumption(who: Person, run: RunJson, assumption: number, alternative?: string): Promise<void>;
    /** `who` reacts with `emoji` to a message or to a run's turn. */
    react(who: Person, on: RequestJson | RunJson, emoji: string): Promise<void>;
    log(line: string): void;
}

/** A target as a scenario names it (the revision it was seen in is the latest one when it is sent). */
export interface TargetSpec {
    readonly target: Target;
    readonly label: string;
}

export interface SeedOptions {
    readonly scenarios: readonly ScenarioName[];
    /** The workspace copied (examples/shop). */
    readonly source: string;
    /** Where the copy goes: made, or wiped first with `reset` when a seed made it. */
    readonly dir: string;
    readonly reset: boolean;
    /** The Live View's port. */
    readonly port: number;
    /** Tag the messages 依頼 / 会話 with the mock classifier (else the classifier stays off). */
    readonly classifier: boolean;
    /** Leave one run queued at the end (a real subscriber started later takes it). */
    readonly leaveQueued: boolean;
    /**
     * Leave one run running at the end, held by the seed's agent until the server stops (or the run is cancelled), and
     * two queued behind it, which the agent then runs the same way, one after the other.
     */
    readonly leaveRunning?: boolean;
    /** The built CLI (`node dist/dt.js`): the session server, and `dt fmt` / `dt check` after each run. */
    readonly dt: DtCommand;
    /** Progress of the seed. */
    readonly log: (line: string) => void;
    /** The session server's own output, line by line. */
    readonly serverLog: (line: string) => void;
}

export interface Seeded {
    readonly dir: string;
    readonly url: string;
    /** A fresh one-time facilitator link (the start's was used by the seeded facilitator). */
    readonly facilitatorLink: string;
    readonly participants: readonly Participant[];
    /** Where the participants' cookies are written. */
    readonly seedFile: string;
    readonly state: SessionStateBody;
    /** Resolves with the server's exit code when it exits. */
    readonly exited: Promise<number | null>;
    /** Stops the session server (SIGINT, as Ctrl+C) and the mock classifier. */
    stop(): Promise<void>;
}

/** Starts `dt collab` (without the agent in process: the seed's agent plays the runs) and waits for its Live View and facilitator link. */
async function startServer(
    options: SeedOptions,
    classifier: MockClassifier | undefined,
): Promise<{ child: ChildProcess; url: string; link: string; exited: Promise<number | null> }> {
    // --yes: the seed wrote this workspace's config itself (its mock classifier is a security-relevant setting)
    const child = spawn(options.dt.command, [...options.dt.args, '-r', options.dir, 'collab', '--no-agent', '--yes', '--port', String(options.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(classifier && { DOMAINTRAIL_CLASSIFIER_URL: classifier.url, [SEED_TOKEN_ENV]: 'seed' }) },
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const output: string[] = [];
    let url: string | undefined;
    let link: string | undefined;
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => (ready = resolve));
    const lines = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            output.push(line);
            options.serverLog(line);
            url ??= /^Live View: (\S+)/.exec(line)?.[1];
            link ??= /^Facilitator link[^:]*: (\S+)/.exec(line)?.[1];
            if (url && link) ready();
        }
    };
    child.stdout?.on('data', lines);
    child.stderr?.on('data', lines);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 60_000).unref());
    const first = await Promise.race([started.then(() => 'started' as const), exited.then(() => 'exited' as const), timeout]);
    if (first !== 'started' || !url || !link) {
        child.kill('SIGTERM');
        throw new Error(`dt collab did not start (${first}):\n${output.join('\n')}`);
    }
    return { child, url, link, exited };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function seed(options: SeedOptions): Promise<Seeded> {
    const dir = path.resolve(options.dir);
    if (options.leaveQueued && options.leaveRunning) throw new Error('Leave a run queued or running, not both');
    await prepareDir(dir, options.reset);
    options.log(`Copying ${options.source} to ${dir}`);
    await copyWorkspace(options.source, dir, { port: options.port, classifier: options.classifier });

    const classifier = options.classifier ? await startMockClassifier() : undefined;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let agent: FakeAgent | undefined;
    const stop = async (): Promise<void> => {
        await agent?.stop().catch(() => undefined);
        if (server && server.child.exitCode === null) {
            server.child.kill('SIGINT');
            await server.exited;
        }
        await classifier?.close();
    };
    try {
        server = await startServer({ ...options, dir }, classifier);
        const api = sessionClient(server.url);
        options.log(`Session server at ${server.url}`);

        // the people: the facilitator first, made the facilitator with the start's link, then the participants
        const joined: Record<Person, Participant> = {
            facilitator: await api.join(PEOPLE.facilitator),
            sato: await api.join(PEOPLE.sato),
            suzuki: await api.join(PEOPLE.suzuki),
            tanaka: await api.join(PEOPLE.tanaka),
            takahashi: await api.join(PEOPLE.takahashi),
        };
        await api.claimFacilitator(joined.facilitator, server.link);
        const f = joined.facilitator;

        agent = await startFakeAgent({ root: dir, dt: options.dt, log: (line) => options.log(`  agent: ${line}`) });
        const ctx = makeCtx({ root: dir, api, people: joined, agent, classifier, log: options.log });
        for (const name of options.scenarios) {
            options.log(`Scenario ${name}`);
            await SCENARIOS[name](ctx);
        }
        if (agent.pending() > 0) throw new Error(`${agent.pending()} scripted step(s) were not played: a run the scenario expected never ran`);
        if (options.leaveRunning) await leaveRunning(ctx, agent);
        else {
            // the seed's agent holds nothing from now on: a real subscriber takes the runs queued later
            await agent.stop();
            agent = undefined;
        }

        if (options.leaveQueued) {
            const left = await ctx.say('sato', '最後にもう一件: #返品が依頼された[1] に返品の受付期限（注文から30日）を入れてください', {
                targets: [ctx.es('Returns', 'ReturnRequested', '返品が依頼された')],
                reads: 'request',
            });
            await api.queue(f, { requests: [left.id] });
            options.log('Left one run queued: the next subscriber takes it.');
        }

        const state = await api.state(f);
        const link = await api.facilitatorLink(f);
        const seedFile = await writeSeedFile(dir, {
            url: server.url,
            participants: Object.values(joined).map((p) => ({ name: p.name, role: p.me.participant.role, id: p.me.participant.id, cookie: p.cookie })),
        });
        return {
            dir,
            url: server.url,
            facilitatorLink: link,
            participants: Object.values(joined),
            seedFile,
            state,
            exited: server.exited,
            stop,
        };
    } catch (e) {
        await stop();
        throw e;
    }
}

/**
 * One run left running (the agent works on it until it is cancelled) and two queued behind it, in AI の作業's groups
 * 実行中 and 待ち; each queued one runs the same way once the one before is cancelled.
 */
async function leaveRunning(ctx: Ctx, agent: FakeAgent): Promise<void> {
    const f = ctx.people.facilitator;
    const hang: Step = { kind: 'hang' };
    const running = await ctx.say('tanaka', '返品の受付期限を注文から 30 日にしたいです', { reads: 'request' });
    agent.expect(hang);
    const first = await ctx.api.queue(f, { requests: [running.id] });
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while ((await ctx.api.state(f)).runs.find((r) => r.id === first.id)?.state !== 'Running') {
        if (Date.now() > deadline) throw new Error(`Run ${first.id} did not start`);
        await sleep(100);
    }
    const address = await ctx.say('sato', '請求書の宛名を後から変えられるようにしてください', { reads: 'request' });
    agent.expect(hang);
    await ctx.api.queue(f, { requests: [address.id] });
    const carrier = await ctx.say('suzuki', '出荷に配送業者を持たせたいです', { reads: 'request' });
    const tracking = await ctx.say('takahashi', '配送業者ごとに追跡番号も残したいです', { reads: 'request' });
    agent.expect(hang);
    await ctx.api.queue(f, { requests: [carrier.id, tracking.id] });
    ctx.log("Left one run running (the seed's agent holds it) and two queued behind it.");
}

function makeCtx(deps: {
    root: string;
    api: SessionClient;
    people: Record<Person, Participant>;
    agent: FakeAgent;
    classifier: MockClassifier | undefined;
    log: (line: string) => void;
}): Ctx {
    const { api, people, agent } = deps;
    const f = people.facilitator;

    const latestRevision = async (): Promise<string> => {
        const revisions = (await api.state(f)).revisions;
        const last = [...revisions].sort((a, b) => a.takenAt.localeCompare(b.takenAt)).at(-1);
        if (!last) throw new Error('The session has no revision');
        return last.id;
    };

    /** Waits for the run to reach one of `states`. */
    const until = async (run: RunJson, states: ReadonlySet<string>): Promise<RunJson> => {
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        for (;;) {
            const now = (await api.state(f)).runs.find((r) => r.id === run.id);
            if (!now) throw new Error(`Run ${run.id} is gone`);
            if (states.has(now.state)) return now;
            if (Date.now() > deadline) throw new Error(`Run ${run.id} is still ${now.state} after ${RUN_TIMEOUT_MS / 1000} s`);
            await sleep(100);
        }
    };

    const played = async (queued: RunJson, step: Step): Promise<RunJson> => {
        const ended = await until(queued, ENDED);
        const expected =
            step.kind === 'exit' || step.kind === 'crash'
                ? 'Failed'
                : step.kind === 'hang'
                  ? 'Cancelled'
                  : { done: 'Completed', clarification: 'NeedsClarification', declined: 'Declined' }[step.reply.outcome];
        if (ended.state !== expected) {
            const why = ended.state === 'Failed' ? ` (${ended.reason}${ended.report ? `, ${JSON.stringify(ended.report)}` : ''})` : '';
            throw new Error(`Run ${ended.id} ended ${ended.state}${why}, not ${expected}`);
        }
        deps.log(`  run ${ended.id.slice(0, 8)}: ${ended.state}`);
        return ended;
    };

    const queue = async (body: Parameters<SessionClient['queue']>[1], step: Step): Promise<RunJson> => {
        agent.expect(step);
        return played(await api.queue(f, body), step);
    };

    /** The facilitator sends one message to the AI (「AI に送る」): the run its triage queues, once it ended. */
    const send = async (request: RequestJson, step: Step): Promise<RunJson> => {
        agent.expect(step);
        // stage 3, when it is asked (no classifier, or one unsure), reads it as a change request
        agent.sendsForRun(plainBody(request.body, { targets: request.targets.length, people: request.mentions?.length ?? 0 }));
        await api.address(f, request.id);
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        for (;;) {
            const state = await api.state(f);
            const run = state.runs.find((r) => r.input.requests.some((x) => x.request === request.id));
            if (run) return played(run, step);
            if (Date.now() > deadline) {
                const triage = state.triages?.find((t) => t.request === request.id);
                throw new Error(`The message ${request.id} sent to the AI queued no run (its triage: ${JSON.stringify(triage)})`);
            }
            await sleep(100);
        }
    };

    return {
        root: deps.root,
        api,
        people,
        dt: (element, label) => ({ target: { kind: 'DtElement', element }, label }),
        es: (storming, local, label) => ({ target: { kind: 'DtesElement', storming, local }, label }),
        occurrence: (storming, timeline, eventName, step, label) => ({
            target: { kind: 'DtesOccurrence', storming, timeline, eventName, occurrence: step },
            label,
        }),
        async say(who, body, options = {}) {
            const mentions = (options.mentions ?? []).map((p) => people[p].me.participant.id);
            // the classifier is asked the body with its mentions as names
            if (options.reads)
                deps.classifier?.expect(plainBody(body, { targets: options.targets?.length ?? 0, people: mentions.length }, true), options.reads);
            const revision = await latestRevision();
            const targets = (options.targets ?? []).map((t) => ({ target: t.target, sourceRevision: revision, label: t.label }));
            return api.send(people[who], {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON of a target snapshot (the server checks it)
                targets: targets as Parameters<SessionClient['send']>[1]['targets'],
                body,
                ...(options.replyTo && {
                    replyTo:
                        'input' in options.replyTo
                            ? { kind: 'Run' as const, run: options.replyTo.id }
                            : { kind: 'Message' as const, request: options.replyTo.id },
                }),
                ...(mentions.length > 0 && { mentions }),
            });
        },
        apply: (requests, step, options = {}) =>
            requests.length === 1 && !options.note
                ? send(requests[0], step)
                : queue({ requests: requests.map((r) => r.id), ...(options.note && { note: options.note }) }, step),
        answer: (run, answer, step) => queue({ requests: run.input.requests.map((r) => r.request), answerTo: run.id, answer }, step),
        // the pick is a run of the same requests with `pick`, and the note the page writes for it
        pickAlternative(run, assumption, alternative, step) {
            const a = run.state === 'Completed' ? run.reply?.assumptions[assumption] : undefined;
            const alt = a?.alternatives.find((x) => x.id === alternative);
            if (!a || !alt) throw new Error(`Run ${run.id} has no alternative ${alternative} of assumption ${assumption}`);
            return queue(
                {
                    requests: run.input.requests.map((r) => r.request),
                    note: alternativeNote(a.text, alt.label),
                    pick: { pickOf: run.id, assumption, alternative },
                },
                step,
            );
        },
        async revert(run, name, step) {
            if (step) agent.expect(step);
            // the queue is empty here: the server takes the revert at once, before it answers
            const { run: reverted } = await api.revert(f, run.id, revertBody(name));
            if (reverted.state === 'Reverted') {
                if (step) throw new Error(`The revert of run ${run.id} was mechanical, not the agent's`);
                deps.log(`  run ${reverted.id.slice(0, 8)}: ${reverted.state} (reverted mechanically${reverted.changed ? '' : ', nothing left'})`);
                return reverted;
            }
            const why = reverted.state === 'Queued' ? (reverted.revertObstacle?.kind ?? 'not tried yet') : reverted.state;
            if (!step) throw new Error(`The revert of run ${run.id} went to the agent (${why}), not mechanical`);
            deps.log(`  the revert of run ${run.id.slice(0, 8)} went to the agent (${why})`);
            return played(reverted, step);
        },
        async approveAssumption(run, assumption) {
            await api.approve(f, { run: run.id, assumption });
        },
        async cancelWhileRunning(requests) {
            const step: Step = { kind: 'hang' };
            agent.expect(step);
            const queued = await api.queue(f, { requests: requests.map((r) => r.id) });
            await until(queued, new Set(['Running']));
            await api.cancel(f, queued.id);
            return played(queued, step);
        },
        async voteOption(who, run, question, option) {
            await api.mark(people[who], { target: { kind: 'QuestionOption', run: run.id, question, option }, sign: { kind: 'Vote' }, placed: true });
        },
        async voteAssumption(who, run, assumption, alternative) {
            await api.mark(people[who], {
                target: { kind: 'AssumptionChoice', run: run.id, assumption, ...(alternative !== undefined && { alternative }) },
                sign: { kind: 'Vote' },
                placed: true,
            });
        },
        async react(who, on, emoji) {
            const target = 'body' in on ? { kind: 'Message' as const, request: on.id } : { kind: 'Turn' as const, run: on.id };
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON of a mark target (the server checks it)
            await api.mark(people[who], { target, sign: { kind: 'Reaction', emoji }, placed: true } as Parameters<SessionClient['mark']>[1]);
        },
        log: deps.log,
    };
}
