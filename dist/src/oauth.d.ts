import type { XaiDiscovery, XaiTokenPayload } from "./types.js";
export interface PkcePair {
    verifier: string;
    challenge: string;
}
export declare function generatePkce(): PkcePair;
export declare function validateXaiOAuthEndpoint(url: string, field?: string): string;
export declare function discoverXaiOAuth(fetchImpl?: typeof fetch): Promise<XaiDiscovery>;
export declare function buildXaiAuthorizeUrl(input: {
    authorizationEndpoint: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    nonce: string;
}): string;
export declare function exchangeXaiCodeForTokens(input: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    codeChallenge: string;
    fetchImpl?: typeof fetch;
}): Promise<XaiTokenPayload>;
export declare function refreshXaiTokens(input: {
    tokenEndpoint: string;
    refreshToken: string;
    fetchImpl?: typeof fetch;
}): Promise<XaiTokenPayload>;
export declare function parseOAuthCallbackInput(input: string, expectedState: string): {
    code: string;
    state: string;
} | {
    error: string;
};
export declare function createOAuthState(): string;
export declare function createOAuthNonce(): string;
export declare function tokenResultToAuthResult(input: {
    accessToken: string;
    refresh: string;
    expiresAt: number;
}): {
    type: "success";
    provider: string;
    refresh: string;
    access: string;
    expires: number;
};
