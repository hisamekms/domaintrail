// `bun run shots`: the Event Storming guide's captures of the Live View, taken from its example workspaces into
// public/shots/event-storming/<name>.png.
//
// For each scene it copies an example to a scratch directory, starts `dt open --no-agent` (or `dt collab`) on a port
// from SHOTS_PORT (4750 by default) up, and drives the page with Playwright. In place of Claude Code, a scripted
// answerer (the real `startAnswerer` of @domaintrail/agent, paired as `dt agent` is) answers the interview, the
// candidates and the guide with fixed replies, so the screens are the real UI with known contents.
//
// It needs the root's `bun install` and `bun run build` (it imports the workspace packages, and `dt open` serves the
// built page) and a Chrome: PLAYWRIGHT_MODULE names the
// playwright package to use (else `playwright` as installed, else the one of playwright-cli under mise), and
// PLAYWRIGHT_CHANNEL the browser channel (`chrome` by default). Run it with a scratch state env (DOMAINTRAIL_STATE_DIR,
// XDG_STATE_HOME, XDG_CACHE_HOME): the sessions it starts are kept in the state directory.
//
//   bun run shots              every scene
//   bun run shots guide-card   the scenes that write these captures
import { type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createHttpAgentApi,
    randomNonce,
    scanWorkspace,
    startAnswerer,
    systemClock,
    type AnswerAgent,
    type AnswerTurnResult,
    type Answerer,
} from '@domaintrail/agent';
import { issueAgentLink, pairAgent } from '@domaintrail/dt';
import { ES, ES_EXAMPLES, SITE, dtStart } from './dt.ts';

// the captures of the Event Storming guide (public/shots/<guide>/: each guide has its own)
const OUT = join(SITE, 'public', 'shots', ES);
const STORMING = 'CertificateIssuance';
const ref = (local: string): string => `@{es:${STORMING}/${local}}`;
// the scripted interview's questions: each turn is told by the question its transcript already holds
const STORMING_QUESTION = 'どのストーミングのブリーフを決めますか？';
const GOAL_QUESTION = 'どこまで進めますか？';

// ---- Playwright, without a dependency of the site's own ----

// Playwright is loaded at run time from where it is installed (no dependency of the site), so its types are not known
type Page = any;
type Browser = any;

async function loadPlaywright(): Promise<{ chromium: any }> {
    const candidates = [
        process.env.PLAYWRIGHT_MODULE,
        'playwright',
        join(homedir(), '.local/share/mise/installs/npm-playwright-cli/latest/node_modules/playwright/index.js'),
    ].filter((c): c is string => Boolean(c));
    for (const c of candidates) {
        try {
            return await import(c);
        } catch {
            // the next one
        }
    }
    throw new Error(`No playwright package found (tried ${candidates.join(', ')}); set PLAYWRIGHT_MODULE`);
}

// ---- the scripted AI ----

const structured = (value: Record<string, unknown>): AnswerTurnResult => ({ structured: value, text: JSON.stringify(value), model: 'site-shots' });

/** The fixed replies: an interview's first question with choices, the exceptions of the stage, the guide's steps. */
const scriptedAgent: AnswerAgent = {
    triage: async () => structured({ kind: 'neither', confidence: 0.95, reason: 'site shots' }),
    answer: async () => structured({ kind: 'neither', reason: 'site shots' }),
    // /es:start: the storming (a choice by its label), then how far (a choice), then the brief
    interview: async (turn) => {
        if (turn.prompt.includes(GOAL_QUESTION))
            return structured({
                kind: 'brief',
                brief: {
                    name: STORMING,
                    isNew: false,
                    journey: {
                        purpose: '住民票をコンビニで取る流れを知り、つまずくところを見つける',
                        scope: '住民票を頼まれてから、提出先に受け取ってもらうまで',
                        participants: ['窓口担当', '申請者'],
                        use: 'modeling',
                        level: 'BigPicture',
                    },
                },
            });
        if (turn.prompt.includes(STORMING_QUESTION))
            return structured({ kind: 'question', question: GOAL_QUESTION, choices: ['Big Picture', 'デザインレベル'], multiple: false });
        return structured({ kind: 'question', question: STORMING_QUESTION, choices: [`@{es:${STORMING}}`, '新しいストーミング'], multiple: false });
    },
    command: async (turn) => {
        if (turn.type === 'candidates')
            return structured({
                kind: 'candidates',
                candidates: [
                    {
                        label: '利用時間外だった',
                        targets: [ref('StoreVisited')],
                        how: 'コンビニに行った から分かれ、利用時間外だった → 日を改めた → コンビニに行った へ戻る',
                        reason: '早朝や深夜、年末年始は使えないことがある',
                    },
                    {
                        label: 'コピー機が非対応だった',
                        targets: [ref('StoreVisited')],
                        how: 'コンビニに行った から分かれ、コピー機が非対応だった → 対応店舗へ移った → コンビニに行った へ戻る',
                        reason: 'すべての店舗が対応しているわけではない',
                    },
                    {
                        label: '暗証番号がロックされた',
                        targets: [ref('CardRead')],
                        how: 'カードを読み取った から分かれ、暗証番号がロックされた → 市役所で再設定した → 暗証番号を入力した へ戻る',
                        reason: '何度か間違えると使えなくなる',
                    },
                    {
                        label: '店が混んでいた',
                        targets: [ref('StoreVisited')],
                        how: 'コンビニに行った から分かれ、店が混んでいた → コンビニに行った へ戻る',
                        reason: '業務の例外ではないかもしれない',
                    },
                ],
            });
        if (turn.prompt.includes(STORMING))
            return structured({
                kind: 'next',
                status: '流れと段階ができました。次は、段階ごとの例外です。',
                steps: [
                    {
                        text: '「コンビニでの発行」の例外を出す',
                        reason: 'どの段階にも、まだ例外がありません',
                        command: 'es:exceptions',
                        targets: [ref('AtStore')],
                    },
                    {
                        text: '暗証番号で困ったことを聞く',
                        reason: '窓口に回される場面が多いところです',
                        targets: [ref('PinEntered')],
                        ask: '暗証番号を忘れたら、どこで再設定する？',
                    },
                ],
            });
        return structured({
            kind: 'next',
            status: 'まだ何も書かれていません。まずゴールを決めましょう。',
            steps: [{ text: 'ゴールを決める', reason: '何のために、どこまで行うかが決まると、地図が描けます', command: 'es:start' }],
        });
    },
};

async function startScriptedAnswerer(root: string): Promise<Answerer> {
    const credential = await pairAgent(root, (await issueAgentLink(root)).code);
    const api = createHttpAgentApi({ url: credential.url, token: credential.token });
    return startAnswerer({ api, agent: scriptedAgent, workspace: { scan: () => scanWorkspace(root) }, clock: systemClock, nonce: randomNonce, log: () => {} });
}

// ---- a session on a copy of an example ----

let nextPort = Number(process.env.SHOTS_PORT ?? 4750);
const WORK = mkdtempSync(join(tmpdir(), 'dt-site-shots-'));

interface Session {
    readonly root: string;
    readonly url: string;
    readonly stop: () => Promise<void>;
}

/** Waits for a line of the server's output that matches, and returns the match. */
function waitFor(child: ChildProcess, pattern: RegExp, ms = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error(`dt printed no ${pattern} in ${ms} ms:\n${seen}`)), ms);
        const on = (chunk: Buffer): void => {
            seen += chunk.toString();
            const m = pattern.exec(seen);
            if (m) {
                clearTimeout(timer);
                resolve(m[0]);
            }
        };
        child.stdout?.on('data', on);
        child.stderr?.on('data', on);
        child.on('exit', (code) => reject(new Error(`dt exited (${code}):\n${seen}`)));
    });
}

/** A scratch copy of an example (or an empty workspace), `edit` applied to its storming; `journey: false` without its journey file. */
function workspace(name: string, example: string | undefined, edit?: (dtes: string) => string, journey = true): string {
    const root = join(WORK, name);
    rmSync(root, { recursive: true, force: true });
    if (example) cpSync(join(ES_EXAMPLES, example), root, { recursive: true });
    else {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'domaintrail.jsonc'), '{ "sources": ["**/*.dtes"] }\n');
    }
    // the copy is outside site/: its $schema path would point nowhere
    const config = join(root, 'domaintrail.jsonc');
    writeFileSync(config, readFileSync(config, 'utf8').replace(/^\s*"\$schema".*\n/m, ''));
    if (!journey) rmSync(join(root, 'domaintrail.journey.json'), { force: true });
    const file = join(root, 'stormings', 'certificate.dtes');
    if (edit && existsSync(file)) writeFileSync(file, edit(readFileSync(file, 'utf8')));
    return root;
}

async function startSession(root: string, mode: 'open' | 'collab'): Promise<Session> {
    const port = nextPort++;
    const args =
        mode === 'open' ? ['-r', root, 'open', '--no-agent', '--port', String(port)] : ['-r', root, 'collab', '--no-agent', '--yes', '--port', String(port)];
    const child = dtStart(args);
    const url = await waitFor(child, new RegExp(`http://127\\.0\\.0\\.1:${port}/\\S*(?:code|token|link|facilitator)\\S*`));
    const answerer = await startScriptedAnswerer(root);
    return {
        root,
        url,
        stop: async () => {
            await answerer.stop();
            child.kill('SIGINT');
            await new Promise((r) => setTimeout(r, 800));
            if (child.exitCode === null) child.kill('SIGTERM');
        },
    };
}

// ---- the page ----

const COMPOSER = '.chat-composer [contenteditable]';
// the chat's column (the journey chip's wrap in the app bar also carries .session-chat)
const CHAT = '.session-chat:not(.session-bar):not(.journey-chip-wrap)';

async function openPage(browser: Browser, url: string, width = 1440, height = 900, waitApp = true): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'ja-JP', colorScheme: 'light' });
    const page = await context.newPage();
    page.on('pageerror', (e: Error) => console.log('  page error:', e.message));
    await page.goto(url);
    if (waitApp) await page.waitForSelector('.app-bar, header', { timeout: 30_000 });
    await page.waitForTimeout(1500);
    return page;
}

async function world(page: Page, label: 'イベントストーミング' | 'ドメインモデル'): Promise<void> {
    await page
        .getByRole('button', { name: label })
        .or(page.getByRole('tab', { name: label }))
        .or(page.getByRole('radio', { name: label }))
        .first()
        .click();
    // the legend starts hidden (each view keeps its own toggle), so the diagram is not covered
    await page.waitForTimeout(1200);
}

async function slash(page: Page, command: string): Promise<void> {
    await page.locator(COMPOSER).click();
    await page.keyboard.insertText(command);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    // a command picked from `/`'s list is sent with Enter
    if ((await page.locator(COMPOSER).innerText()).trim().length > 0) await page.keyboard.press('Enter');
}

/** Waits until the AI's spinner is gone from the chat (the scripted answerer replies within a second or two). */
async function settle(page: Page, ms = 20_000): Promise<void> {
    const t0 = Date.now();
    await page.waitForTimeout(1500);
    while (Date.now() - t0 < ms) {
        if ((await page.locator('.candidates .spin, .chat-ai-pending, .guide-thinking .spin').count()) === 0) break;
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(800);
}

async function shot(page: Page, name: string, selector?: string): Promise<void> {
    const path = join(OUT, `${name}.png`);
    // no hover left on a row (its floating actions)
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    if (selector) await page.locator(selector).last().screenshot({ path });
    else await page.screenshot({ path });
    console.log(`  shot ${name}`);
}

// ---- the scenes ----

interface Scene {
    readonly writes: readonly string[];
    readonly run: (browser: Browser) => Promise<void>;
}

const SCENES: readonly Scene[] = [
    {
        // nothing written yet: the event storming world says how to start; the guide's map is "set the goal"
        writes: ['empty-world', 'guide-nogoal'],
        run: async (browser) => {
            const s = await startSession(workspace('empty', undefined), 'open');
            try {
                const page = await openPage(browser, s.url);
                await world(page, 'イベントストーミング');
                await shot(page, 'empty-world');
                await page.locator('button.chat-guide').click();
                await settle(page);
                await shot(page, 'guide-nogoal', '.guide-card');
            } finally {
                await s.stop();
            }
        },
    },
    {
        // the brief: /es:start on the events with no journey yet, its choices (the storming by its label, how far),
        // the brief, the note once confirmed, then the journey's chip and its panel
        writes: ['interview-choice', 'brief', 'completion-note', 'journey-chip', 'journey-panel'],
        run: async (browser) => {
            const s = await startSession(workspace('certificate', 'events', undefined, false), 'open');
            try {
                const page = await openPage(browser, s.url);
                await world(page, 'イベントストーミング');
                await slash(page, '/es:start');
                await settle(page);
                await page.locator('.interview-choices').waitFor({ timeout: 20_000 });
                await shot(page, 'interview-choice', CHAT);
                await page.locator('.interview-choices button').first().click();
                await page.getByText(GOAL_QUESTION).last().waitFor({ timeout: 20_000 });
                await settle(page);
                await page.locator('.interview-choices button').first().click();
                await page.locator('.chat-brief').waitFor({ timeout: 20_000 });
                await settle(page);
                await shot(page, 'brief', '.chat-interview');
                await page.locator('.chat-brief-actions button', { hasText: '確定' }).first().click();
                await page.locator('.journey-note-actions').waitFor({ timeout: 20_000 });
                await settle(page);
                await shot(page, 'completion-note', CHAT);
                // the app bar from its left end to the chip
                const chip = await page.locator('button.journey-chip').boundingBox();
                const bar = await page.locator('.app-bar').boundingBox();
                await page.screenshot({
                    path: join(OUT, 'journey-chip.png'),
                    clip: { x: 0, y: bar.y, width: Math.ceil(chip.x + chip.width + 16), height: Math.ceil(bar.height) },
                });
                console.log('  shot journey-chip');
                await page.locator('button.journey-chip').click();
                await page.locator('.journeys-panel').waitFor({ timeout: 10_000 });
                await page.waitForTimeout(600);
                await shot(page, 'journey-panel', '.journeys-panel');
            } finally {
                await s.stop();
            }
        },
    },
    {
        // a storming with its description only
        writes: ['storming-empty'],
        run: async (browser) => {
            const s = await startSession(
                workspace('brief-only', 'events', (t) => t.replace(/\n {2}event [^\n]*/g, '')),
                'open',
            );
            try {
                const page = await openPage(browser, s.url);
                await world(page, 'イベントストーミング');
                await shot(page, 'storming-empty');
            } finally {
                await s.stop();
            }
        },
    },
    {
        // flows and stages: the navigator and the view bar on a stage; /es:exceptions on it; the guide
        writes: ['view-switch', 'exceptions-candidates', 'guide-card'],
        run: async (browser) => {
            const s = await startSession(workspace('flows', 'flows'), 'open');
            try {
                const page = await openPage(browser, s.url);
                await world(page, 'イベントストーミング');
                await page.getByText('コンビニでの発行', { exact: true }).first().click();
                await page.waitForTimeout(1500);
                await shot(page, 'view-switch');
                await slash(page, '/es:exceptions');
                await settle(page);
                const boxes = page.locator('.candidates input[type=checkbox]');
                for (let i = 0; i < Math.min(3, await boxes.count()); i++) await boxes.nth(i).check();
                await shot(page, 'exceptions-candidates', CHAT);
                await page.locator('button.chat-guide').click();
                await settle(page);
                await shot(page, 'guide-card', '.guide-card');
            } finally {
                await s.stop();
            }
        },
    },
    {
        // the view bar's 書き出し menu on the Design Level storming
        writes: ['export-menu'],
        run: async (browser) => {
            const s = await startSession(workspace('design', 'design'), 'open');
            try {
                const page = await openPage(browser, s.url);
                await world(page, 'イベントストーミング');
                await page
                    .getByRole('button', { name: /書き出し/ })
                    .first()
                    .click();
                await page.waitForTimeout(800);
                await shot(page, 'export-menu');
            } finally {
                await s.stop();
            }
        },
    },
    {
        // a collab with a second person: the collab menu (participants, invite)
        writes: ['collab-menu'],
        run: async (browser) => {
            const s = await startSession(workspace('collab', 'questions'), 'collab');
            try {
                const page = await openPage(browser, s.url, 1440, 900, false);
                const join = async (p: Page, name: string): Promise<void> => {
                    const field = p.locator('input[name=name], input[type=text]').first();
                    if ((await field.count()) > 0 && (await field.isVisible())) {
                        await field.fill(name);
                        await p.keyboard.press('Enter');
                        await p.waitForTimeout(2000);
                    }
                };
                await join(page, '進行役');
                const other = await openPage(browser, s.url.replace(/(127\.0\.0\.1:\d+)\/.*/, '$1/'), 1440, 900, false);
                await join(other, '窓口担当');
                await world(page, 'イベントストーミング');
                await page.locator('.chat-head button, .collab-menu-button').first().click();
                await page.waitForTimeout(800);
                await shot(page, 'collab-menu');
            } finally {
                await s.stop();
            }
        },
    },
];

// ---- main ----

const wanted = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
let failed = 0;
try {
    for (const scene of SCENES) {
        if (wanted.length > 0 && !scene.writes.some((w) => wanted.includes(w))) continue;
        console.log(`scene: ${scene.writes.join(', ')}`);
        try {
            await scene.run(browser);
        } catch (e) {
            failed++;
            console.error(`  FAIL: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
} finally {
    await browser.close();
    rmSync(WORK, { recursive: true, force: true });
}
process.exit(failed > 0 ? 1 : 0);
