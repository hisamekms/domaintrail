// The `access` identity mode (ADR 0026): a Cloudflare Access token (`Cf-Access-Jwt-Assertion` header or
// `CF_Authorization` cookie) proves an identity. The token's signature is checked by an `AccessTokenVerifier` against
// the team's keys (JWKS: S8); this adapter checks the claims (issuer, audience, expiry) and makes the identity. Until S8
// the verifier is a mock (`createMockAccessVerifier`), used by the tests.
import type { Identity, IdentityProvider } from '../application/identity.js';
import type { Clock } from '../application/ports.js';

/** The claims of an Access token whose signature holds. */
export interface AccessClaims {
    readonly iss: string;
    readonly aud: string | readonly string[];
    readonly sub: string;
    /** Seconds since the epoch. */
    readonly exp: number;
    readonly email?: string;
    readonly name?: string;
}

/** Checks a token's signature with the team's keys; its claims, or `undefined` when it is not a token signed by them. */
export interface AccessTokenVerifier {
    verify(token: string): Promise<AccessClaims | undefined>;
}

export interface AccessSettings {
    /** `<team>.cloudflareaccess.com` (or with `https://`): the issuer of the tokens. */
    readonly teamDomain: string;
    /** The application's audience tag (AUD). */
    readonly audience: string;
}

/** The issuer of the team's tokens: `https://<teamDomain>` without a trailing slash. */
export const accessIssuer = (teamDomain: string): string => (teamDomain.startsWith('https://') ? teamDomain : `https://${teamDomain}`).replace(/\/+$/, '');

/** Largest token accepted (a JWT of Access is about 1 kB). */
const MAX_TOKEN = 8192;

export function createAccessIdentityProvider(settings: AccessSettings, verifier: AccessTokenVerifier, clock: Clock): IdentityProvider {
    const issuer = accessIssuer(settings.teamDomain);
    return {
        mode: 'access',
        async verify(token) {
            if (!token || token.length > MAX_TOKEN) return undefined;
            const claims = await verifier.verify(token);
            if (!claims || claims.iss !== issuer) return undefined;
            const audiences: readonly string[] = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
            if (!audiences.includes(settings.audience)) return undefined;
            if (!(claims.exp * 1000 > clock.now().getTime())) return undefined;
            if (!claims.sub) return undefined;
            const displayName = (claims.name?.trim() || claims.email?.split('@')[0] || claims.sub).slice(0, 200);
            const identity: Identity = { provider: 'access', subject: claims.sub, displayName, ...(claims.email && { email: claims.email }) };
            return identity;
        },
    };
}

/** A verifier that knows a fixed set of tokens and their claims: the stand-in for the JWKS check until S8, for tests. */
export function createMockAccessVerifier(tokens: ReadonlyMap<string, AccessClaims>): AccessTokenVerifier {
    return { verify: async (token) => tokens.get(token) };
}
