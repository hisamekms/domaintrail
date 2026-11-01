// Collaboration's settings in the `session` section of domaintrail.jsonc (ADR 0026; ADR 0027, Project analysis and
// configuration: Collaboration owns the identity mode and the participant limit): `identity` and `access`,
// `maxParticipants`, `quickReactions`, `classifier`, and `agent.maxPreviousRunDiff` (despite its place, what the run
// pipeline and the agent API give the agent of the previous runs: `domain/previous-runs`). Their types, defaults and
// validation; the app composes them with the other sections and reports the first error (`fail` throws).
import { DEFAULT_QUICK_REACTIONS, readEmoji } from '../domain/emoji.js';
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
export const DEFAULT_CLASSIFIER_THRESHOLD = 0.5;
/** Most emoji in `session.quickReactions`. */
export const MAX_QUICK_REACTIONS = 8;

/** Collaboration's keys, by where they sit in the file. */
export const COLLABORATION_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['session'],
    session: ['identity', 'access', 'agent', 'maxParticipants', 'quickReactions', 'classifier'],
    'session.access': ['teamDomain', 'audience', 'publicUrl', 'allowedHosts', 'allowedOrigins', 'acceptCookie', 'avatarHosts'],
    'session.agent': ['maxPreviousRunDiff'],
    'session.classifier': ['enabled', 'provider', 'model', 'accountId', 'apiTokenEnv', 'threshold'],
};

/** Collaboration's part of the `session` section of the config file. */
export interface CollaborationConfigFile {
    /** `dev` (loopback only, a name picked on the first visit) or `access` (Cloudflare Access). Default: `dev`. */
    identity?: SessionIdentity;
    /** Cloudflare Access, required with `identity: "access"`. */
    access?: {
        /** `<team>.cloudflareaccess.com`: the issuer of the tokens. */
        teamDomain: string;
        /** The Access application's audience tag (AUD). */
        audience: string;
        /** The public URL of the session (the tunnel's). Not used to allow anything: its host and origin must also be in `allowedHosts` and `allowedOrigins`. */
        publicUrl?: string;
        /** Host names the server answers to besides loopback. Default: none. */
        allowedHosts?: string[];
        /** Origins (`https://host[:port]`) whose pages may call the server besides loopback. Default: none. */
        allowedOrigins?: string[];
        /** Whether the `CF_Authorization` cookie is accepted when the `Cf-Access-Jwt-Assertion` header is absent. Default: false. */
        acceptCookie?: boolean;
        /** Hosts an avatar (the identity's `https` picture) may come from. Default: none, the page shows initials. */
        avatarHosts?: string[];
    };
    agent?: {
        /**
         * The most characters of unified diff the agent is given of the runs a run continues (the runs its messages reply
         * to, the run it answers), all of them together; past it, a run's changed files only. Default: 20480.
         */
        maxPreviousRunDiff?: number;
    };
    /** Most participants a session admits. Default: 50. */
    maxParticipants?: number;
    /**
     * The emoji the add-reaction popover of the chat offers first, in order: each exactly one emoji, distinct, at most
     * `MAX_QUICK_REACTIONS`. Any other emoji can still be typed there. Default: 👍 👀 🤔 🎉 ❤️ 🙏.
     */
    quickReactions?: string[];
    /** Telling the chat's requests from its talk (opt-in; the message text goes to the provider). */
    classifier?: {
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
    };
}

/** `session.access` resolved. */
export interface ResolvedAccessConfig {
    teamDomain: string;
    audience: string;
    publicUrl?: string;
    allowedHosts: string[];
    allowedOrigins: string[];
    acceptCookie: boolean;
    avatarHosts: string[];
}

/** The `session.classifier` section resolved. */
export interface ResolvedClassifierConfig {
    enabled: boolean;
    provider: (typeof CLASSIFIER_PROVIDERS)[number];
    model: ClefModel;
    accountId?: string;
    apiTokenEnv: string;
    threshold: number;
}

/** Collaboration's part of the `session` section resolved: every default applied. */
export interface ResolvedCollaborationConfig {
    identity: SessionIdentity;
    access?: ResolvedAccessConfig;
    maxPreviousRunDiff: number;
    maxParticipants: number;
    /** In the form reactions are kept (`normalizeEmoji`). */
    quickReactions: string[];
    classifier: ResolvedClassifierConfig;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Checks `session.identity` and `session.access` (`session`: an object). */
export function validateIdentityConfig(session: Record<string, unknown>, fail: (msg: string) => never): void {
    if (session.identity !== undefined && !(SESSION_IDENTITIES as readonly unknown[]).includes(session.identity))
        fail(`'session.identity' must be one of ${SESSION_IDENTITIES.map((m) => `'${m}'`).join(', ')}`);
    const access = session.access;
    if (access !== undefined) {
        if (!isObject(access)) return fail("'session.access' must be an object");
        for (const key of Object.keys(access)) if (!COLLABORATION_CONFIG_KEYS['session.access'].includes(key)) fail(`unknown key 'session.access.${key}'`);
        if (typeof access.teamDomain !== 'string' || !access.teamDomain.trim()) fail("'session.access.teamDomain' must be a non-empty string");
        if (!/^(https:\/\/)?[a-z0-9.-]+\/?$/i.test(access.teamDomain))
            fail(`'session.access.teamDomain' must be a host name like '<team>.cloudflareaccess.com': '${access.teamDomain}'`);
        if (typeof access.audience !== 'string' || !access.audience.trim()) fail("'session.access.audience' must be a non-empty string");
        if (access.publicUrl !== undefined && (typeof access.publicUrl !== 'string' || !URL.canParse(access.publicUrl)))
            fail("'session.access.publicUrl' must be a URL");
        if (access.allowedHosts !== undefined) {
            if (!isStringList(access.allowedHosts)) return fail("'session.access.allowedHosts' must be an array of host names");
            for (const h of access.allowedHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'session.access.allowedHosts' must hold host names only: '${h}'`);
        }
        if (access.acceptCookie !== undefined && typeof access.acceptCookie !== 'boolean') fail("'session.access.acceptCookie' must be a boolean");
        if (access.avatarHosts !== undefined) {
            if (!isStringList(access.avatarHosts)) return fail("'session.access.avatarHosts' must be an array of host names");
            for (const h of access.avatarHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'session.access.avatarHosts' must hold host names only: '${h}'`);
        }
        if (access.allowedOrigins !== undefined) {
            if (!isStringList(access.allowedOrigins)) return fail("'session.access.allowedOrigins' must be an array of origins");
            for (const o of access.allowedOrigins) {
                const origin = URL.canParse(o) ? new URL(o) : undefined;
                if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== o)
                    fail(`'session.access.allowedOrigins' must hold origins like 'https://example.com': '${o}'`);
            }
        }
    }
    if (session.identity === 'access' && access === undefined) fail("'session.identity' \"access\" needs 'session.access' with 'teamDomain' and 'audience'");
}

/** Checks `session.agent.maxPreviousRunDiff` (`agent`: an object). */
export function validatePreviousRunsConfig(agent: Record<string, unknown>, fail: (msg: string) => never): void {
    const max = agent.maxPreviousRunDiff;
    if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max >= 0))
        fail("'session.agent.maxPreviousRunDiff' must be a non-negative integer (characters of diff)");
}

/** Checks `session.classifier`, `session.maxParticipants` and `session.quickReactions` (`session`: an object). */
export function validateCollaborationConfig(session: Record<string, unknown>, fail: (msg: string) => never): void {
    const classifier = session.classifier;
    if (classifier !== undefined) {
        if (!isObject(classifier)) return fail("'session.classifier' must be an object");
        for (const key of Object.keys(classifier))
            if (!COLLABORATION_CONFIG_KEYS['session.classifier'].includes(key)) fail(`unknown key 'session.classifier.${key}'`);
        if (classifier.enabled !== undefined && typeof classifier.enabled !== 'boolean') fail("'session.classifier.enabled' must be a boolean");
        if (classifier.provider !== undefined && !(CLASSIFIER_PROVIDERS as readonly unknown[]).includes(classifier.provider))
            fail(`'session.classifier.provider' must be one of ${CLASSIFIER_PROVIDERS.map((p) => `'${p}'`).join(', ')}`);
        if (classifier.model !== undefined && !(CLEF_MODELS as readonly unknown[]).includes(classifier.model))
            fail(`'session.classifier.model' must be one of ${CLEF_MODELS.map((m) => `'${m}'`).join(', ')}`);
        if (classifier.accountId !== undefined && (typeof classifier.accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(classifier.accountId)))
            fail("'session.classifier.accountId' must be a Cloudflare account ID (32 hexadecimal digits)");
        if (classifier.apiTokenEnv !== undefined && (typeof classifier.apiTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(classifier.apiTokenEnv)))
            fail("'session.classifier.apiTokenEnv' must be the name of an environment variable (the token itself never goes in the file)");
        if (classifier.threshold !== undefined && !(typeof classifier.threshold === 'number' && classifier.threshold > 0 && classifier.threshold < 1))
            fail("'session.classifier.threshold' must be a number between 0 and 1");
        if (classifier.enabled === true && classifier.accountId === undefined) fail("'session.classifier' enabled needs 'accountId'");
    }
    if (
        session.maxParticipants !== undefined &&
        !(typeof session.maxParticipants === 'number' && Number.isInteger(session.maxParticipants) && session.maxParticipants >= 1)
    )
        fail("'session.maxParticipants' must be a positive integer");
    const quick = session.quickReactions;
    if (quick !== undefined) {
        if (!isStringList(quick) || quick.length === 0 || quick.length > MAX_QUICK_REACTIONS)
            return fail(`'session.quickReactions' must be an array of 1 to ${MAX_QUICK_REACTIONS} emoji`);
        const seen = new Set<string>();
        for (const e of quick) {
            const emoji = readEmoji(e);
            if (emoji === undefined) fail(`'session.quickReactions' must hold one emoji per entry: '${e}'`);
            if (seen.has(emoji)) fail(`'session.quickReactions' must not repeat an emoji: '${e}'`);
            seen.add(emoji);
        }
    }
}

/** Collaboration's settings with their defaults (validated). */
export function resolveCollaborationConfig(session: CollaborationConfigFile = {}): ResolvedCollaborationConfig {
    const { access, classifier } = session;
    return {
        identity: session.identity ?? 'dev',
        ...(access && {
            access: {
                teamDomain: access.teamDomain,
                audience: access.audience,
                ...(access.publicUrl !== undefined && { publicUrl: access.publicUrl }),
                allowedHosts: access.allowedHosts ?? [],
                allowedOrigins: access.allowedOrigins ?? [],
                acceptCookie: access.acceptCookie ?? false,
                avatarHosts: access.avatarHosts ?? [],
            },
        }),
        maxPreviousRunDiff: session.agent?.maxPreviousRunDiff ?? DEFAULT_MAX_PREVIOUS_RUN_DIFF,
        maxParticipants: session.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
        // validated: each reads as one emoji
        quickReactions: (session.quickReactions ?? DEFAULT_QUICK_REACTIONS).map((e) => readEmoji(e) ?? e),
        classifier: {
            enabled: classifier?.enabled ?? false,
            provider: classifier?.provider ?? 'cloudflare-clef',
            model: classifier?.model ?? 'clef-flash',
            ...(classifier?.accountId !== undefined && { accountId: classifier.accountId }),
            apiTokenEnv: classifier?.apiTokenEnv ?? DEFAULT_CLASSIFIER_TOKEN_ENV,
            threshold: classifier?.threshold ?? DEFAULT_CLASSIFIER_THRESHOLD,
        },
    };
}
