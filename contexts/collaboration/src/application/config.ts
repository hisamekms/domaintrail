// Collaboration's settings in domaintrail.jsonc (ADR 0026; ADR 0027, Project analysis and configuration: Collaboration
// owns the identity mode and the participant limit; ADR 0030: the sections `collab`, `agent` and `classifier`): in
// `collab`, `identity` and `access` (but its `allowedHosts` and `allowedOrigins`: the app's connection guards, ADR 0027,
// Authorization), `maxParticipants` and `quickReactions`; the top-level `classifier` (called by the server in both
// modes) and `templates` (the chat's message templates, `domain/templates.ts`, in both modes); and `agent.run.maxPreviousRunDiff` (despite its place, what the run pipeline and the agent API give the agent
// of the previous runs: `domain/previous-runs`). Their types, defaults and validation; the app composes them with the
// other sections and reports the first error (`fail` throws).
import { DEFAULT_QUICK_REACTIONS, readEmoji } from '../domain/emoji.js';
import { checkTemplates, type MessageTemplateConfig } from '../domain/templates.js';
import { TRIAGE_THRESHOLDS } from '../domain/triage.js';
import type { IdentityMode } from './identity.js';

/** How the participants of a session prove who they are (ADR 0026): explicit, never inferred from headers. */
export const SESSION_IDENTITIES = ['dev', 'access'] as const satisfies readonly IdentityMode[];
export type SessionIdentity = (typeof SESSION_IDENTITIES)[number];
export const DEFAULT_MAX_PARTICIPANTS = 50;
/** The most characters of unified diff the agent is given of the runs a run continues (replies, answers), together. */
export const DEFAULT_MAX_PREVIOUS_RUN_DIFF = 20 * 1024;
/** The classifiers of a session's chat messages (request or chat), and the models of Cloudflare's Clef. */
export const CLASSIFIER_PROVIDERS = ['cloudflare-clef'] as const;
export const CLEF_MODELS = ['clef-flash', 'clef'] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];
export const DEFAULT_CLASSIFIER_TOKEN_ENV = 'CLOUDFLARE_API_TOKEN';
/** The probability from which one of Clef's answers decides (ADR 0030, Q5), unless configured. */
export const DEFAULT_CLASSIFIER_THRESHOLD = TRIAGE_THRESHOLDS.clef;
/** Most emoji in `collab.quickReactions`. */
export const MAX_QUICK_REACTIONS = 8;

/** Collaboration's keys, by where they sit in the file. */
export const COLLABORATION_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['collab', 'classifier', 'templates'],
    collab: ['identity', 'access', 'maxParticipants', 'quickReactions'],
    'collab.access': ['teamDomain', 'audience', 'publicUrl', 'acceptCookie', 'avatarHosts'],
    'agent.run': ['maxPreviousRunDiff'],
    classifier: ['enabled', 'provider', 'model', 'accountId', 'apiTokenEnv', 'threshold'],
};

/** Collaboration's parts of the config file: its keys of `collab`, the `classifier`, and `agent.run.maxPreviousRunDiff`. */
export interface CollaborationConfigFile {
    collab?: CollabConfigFile;
    classifier?: ClassifierConfigFile;
    agent?: { run?: PreviousRunsConfigFile };
    /** The team's message templates, offered after `/` in the chat after the built-in ones. */
    templates?: MessageTemplateConfig[];
}

/** Collaboration's part of `agent.run`. */
export interface PreviousRunsConfigFile {
    /**
     * The most characters of unified diff the agent is given of the runs a run continues (the runs its messages reply
     * to, the run it answers), all of them together; past it, a run's changed files only. Default: 20480.
     */
    maxPreviousRunDiff?: number;
}

/** Collaboration's part of the `collab` section of the config file. */
export interface CollabConfigFile {
    /** `dev` (loopback only, a name picked on the first visit) or `access` (Cloudflare Access). Default: `dev`. */
    identity?: SessionIdentity;
    /** Cloudflare Access, required with `identity: "access"` (with the app's `allowedHosts` and `allowedOrigins`). */
    access?: {
        /** `<team>.cloudflareaccess.com`: the issuer of the tokens. */
        teamDomain: string;
        /** The Access application's audience tag (AUD). */
        audience: string;
        /** The public URL of the session (the tunnel's). Not used to allow anything: its host and origin must also be in `allowedHosts` and `allowedOrigins`. */
        publicUrl?: string;
        /** Whether the `CF_Authorization` cookie is accepted when the `Cf-Access-Jwt-Assertion` header is absent. Default: false. */
        acceptCookie?: boolean;
        /** Hosts an avatar (the identity's `https` picture) may come from. Default: none, the page shows initials. */
        avatarHosts?: string[];
    };
    /** Most participants a session admits. Default: 50. */
    maxParticipants?: number;
    /**
     * The emoji the add-reaction popover of the chat offers first, in order: each exactly one emoji, distinct, at most
     * `MAX_QUICK_REACTIONS`. Any other emoji can still be typed there. Default: 👍 👀 🤔 🎉 ❤️ 🙏.
     */
    quickReactions?: string[];
}

/** The top-level `classifier`: telling the chat's requests from its talk (opt-in; the message text goes to the provider). */
export interface ClassifierConfigFile {
    /** Default: false (every message can be applied). */
    enabled?: boolean;
    /** Default: `cloudflare-clef` (Workers AI). */
    provider?: (typeof CLASSIFIER_PROVIDERS)[number];
    /** Default: `clef-flash`. */
    model?: ClefModel;
    /** The Cloudflare account of Workers AI; required when enabled. */
    accountId?: string;
    /** The name of the environment variable holding the API token (never the token). Default: `CLOUDFLARE_API_TOKEN`. */
    apiTokenEnv?: string;
    /** The probability from which a message is a request. Default: 0.5. */
    threshold?: number;
}

/** Collaboration's part of `collab.access` resolved. */
export interface ResolvedAccessConfig {
    teamDomain: string;
    audience: string;
    publicUrl?: string;
    acceptCookie: boolean;
    avatarHosts: string[];
}

/** The `classifier` section resolved. */
export interface ResolvedClassifierConfig {
    enabled: boolean;
    provider: (typeof CLASSIFIER_PROVIDERS)[number];
    model: ClefModel;
    accountId?: string;
    apiTokenEnv: string;
    threshold: number;
}

/** Collaboration's parts of the file resolved: every default applied. */
export interface ResolvedCollaborationConfig {
    identity: SessionIdentity;
    access?: ResolvedAccessConfig;
    maxPreviousRunDiff: number;
    maxParticipants: number;
    /** In the form reactions are kept (`normalizeEmoji`). */
    quickReactions: string[];
    classifier: ResolvedClassifierConfig;
    /** The team's message templates as written (validated). */
    templates: readonly MessageTemplateConfig[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Checks `collab.identity` (`collab`: an object). */
export function validateIdentityConfig(collab: Record<string, unknown>, fail: (msg: string) => never): void {
    if (collab.identity !== undefined && !(SESSION_IDENTITIES as readonly unknown[]).includes(collab.identity))
        fail(`'collab.identity' must be one of ${SESSION_IDENTITIES.map((m) => `'${m}'`).join(', ')}`);
}

/**
 * The checks of Collaboration's keys of `collab.access` (an object), by key: the app runs them with its own keys of
 * the section in one order (the first error wins). `teamDomain` and `audience` are required.
 */
export const ACCESS_CHECKS: Readonly<Record<string, (access: Record<string, unknown>, fail: (msg: string) => never) => void>> = {
    teamDomain: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (typeof access.teamDomain !== 'string' || !access.teamDomain.trim()) fail("'collab.access.teamDomain' must be a non-empty string");
        if (!/^(https:\/\/)?[a-z0-9.-]+\/?$/i.test(access.teamDomain))
            fail(`'collab.access.teamDomain' must be a host name like '<team>.cloudflareaccess.com': '${access.teamDomain}'`);
    },
    audience: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (typeof access.audience !== 'string' || !access.audience.trim()) fail("'collab.access.audience' must be a non-empty string");
    },
    publicUrl: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.publicUrl !== undefined && (typeof access.publicUrl !== 'string' || !URL.canParse(access.publicUrl)))
            fail("'collab.access.publicUrl' must be a URL");
    },
    acceptCookie: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.acceptCookie !== undefined && typeof access.acceptCookie !== 'boolean') fail("'collab.access.acceptCookie' must be a boolean");
    },
    avatarHosts: (access: Record<string, unknown>, fail: (msg: string) => never): void => {
        if (access.avatarHosts === undefined) return;
        if (!isStringList(access.avatarHosts)) return fail("'collab.access.avatarHosts' must be an array of host names");
        for (const h of access.avatarHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'collab.access.avatarHosts' must hold host names only: '${h}'`);
    },
};

/** Checks that the identity mode `access` comes with `collab.access` (`collab`: an object). */
export function validateAccessNeeded(collab: Record<string, unknown>, fail: (msg: string) => never): void {
    if (collab.identity === 'access' && collab.access === undefined)
        fail("'collab.identity' \"access\" needs 'collab.access' with 'teamDomain' and 'audience'");
}

/** Checks `agent.run.maxPreviousRunDiff` (`run`: an object). */
export function validatePreviousRunsConfig(run: Record<string, unknown>, fail: (msg: string) => never): void {
    const max = run.maxPreviousRunDiff;
    if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max >= 0))
        fail("'agent.run.maxPreviousRunDiff' must be a non-negative integer (characters of diff)");
}

/** Checks the top-level `classifier` (any value: absent is fine). */
export function validateClassifierConfig(classifier: unknown, fail: (msg: string) => never): void {
    if (classifier === undefined) return;
    if (!isObject(classifier)) return fail("'classifier' must be an object");
    for (const key of Object.keys(classifier)) if (!COLLABORATION_CONFIG_KEYS.classifier.includes(key)) fail(`unknown key 'classifier.${key}'`);
    if (classifier.enabled !== undefined && typeof classifier.enabled !== 'boolean') fail("'classifier.enabled' must be a boolean");
    if (classifier.provider !== undefined && !(CLASSIFIER_PROVIDERS as readonly unknown[]).includes(classifier.provider))
        fail(`'classifier.provider' must be one of ${CLASSIFIER_PROVIDERS.map((p) => `'${p}'`).join(', ')}`);
    if (classifier.model !== undefined && !(CLEF_MODELS as readonly unknown[]).includes(classifier.model))
        fail(`'classifier.model' must be one of ${CLEF_MODELS.map((m) => `'${m}'`).join(', ')}`);
    if (classifier.accountId !== undefined && (typeof classifier.accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(classifier.accountId)))
        fail("'classifier.accountId' must be a Cloudflare account ID (32 hexadecimal digits)");
    if (classifier.apiTokenEnv !== undefined && (typeof classifier.apiTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(classifier.apiTokenEnv)))
        fail("'classifier.apiTokenEnv' must be the name of an environment variable (the token itself never goes in the file)");
    if (classifier.threshold !== undefined && !(typeof classifier.threshold === 'number' && classifier.threshold > 0 && classifier.threshold < 1))
        fail("'classifier.threshold' must be a number between 0 and 1");
    if (classifier.enabled === true && classifier.accountId === undefined) fail("'classifier' enabled needs 'accountId'");
}

/** Checks the top-level `templates` (any value: absent is fine). */
export function validateTemplatesConfig(templates: unknown, fail: (msg: string) => never): void {
    const checked = checkTemplates(templates);
    if (!checked.ok) fail(checked.error);
}

/** Checks `collab.maxParticipants` and `collab.quickReactions` (`collab`: an object). */
export function validateCollaborationConfig(collab: Record<string, unknown>, fail: (msg: string) => never): void {
    if (
        collab.maxParticipants !== undefined &&
        !(typeof collab.maxParticipants === 'number' && Number.isInteger(collab.maxParticipants) && collab.maxParticipants >= 1)
    )
        fail("'collab.maxParticipants' must be a positive integer");
    const quick = collab.quickReactions;
    if (quick !== undefined) {
        if (!isStringList(quick) || quick.length === 0 || quick.length > MAX_QUICK_REACTIONS)
            return fail(`'collab.quickReactions' must be an array of 1 to ${MAX_QUICK_REACTIONS} emoji`);
        const seen = new Set<string>();
        for (const e of quick) {
            const emoji = readEmoji(e);
            if (emoji === undefined) fail(`'collab.quickReactions' must hold one emoji per entry: '${e}'`);
            if (seen.has(emoji)) fail(`'collab.quickReactions' must not repeat an emoji: '${e}'`);
            seen.add(emoji);
        }
    }
}

/** Collaboration's settings with their defaults (validated). */
export function resolveCollaborationConfig(config: CollaborationConfigFile = {}): ResolvedCollaborationConfig {
    const { collab = {}, classifier, templates = [] } = config;
    const { access } = collab;
    return {
        identity: collab.identity ?? 'dev',
        ...(access && {
            access: {
                teamDomain: access.teamDomain,
                audience: access.audience,
                ...(access.publicUrl !== undefined && { publicUrl: access.publicUrl }),
                acceptCookie: access.acceptCookie ?? false,
                avatarHosts: access.avatarHosts ?? [],
            },
        }),
        maxPreviousRunDiff: config.agent?.run?.maxPreviousRunDiff ?? DEFAULT_MAX_PREVIOUS_RUN_DIFF,
        maxParticipants: collab.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
        // validated: each reads as one emoji
        quickReactions: (collab.quickReactions ?? DEFAULT_QUICK_REACTIONS).map((e) => readEmoji(e) ?? e),
        classifier: {
            enabled: classifier?.enabled ?? false,
            provider: classifier?.provider ?? 'cloudflare-clef',
            model: classifier?.model ?? 'clef-flash',
            ...(classifier?.accountId !== undefined && { accountId: classifier.accountId }),
            apiTokenEnv: classifier?.apiTokenEnv ?? DEFAULT_CLASSIFIER_TOKEN_ENV,
            threshold: classifier?.threshold ?? DEFAULT_CLASSIFIER_THRESHOLD,
        },
        templates,
    };
}
