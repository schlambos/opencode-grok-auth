import type { AuthDetails, OAuthAuthDetails, XaiRefreshParts } from "./types.js";
export declare function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails;
export declare function packXaiRefresh(parts: XaiRefreshParts): string;
export declare function parseXaiRefresh(refresh: string): XaiRefreshParts;
export declare function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: unknown, accessToken?: string): number;
export declare function accessTokenExpired(auth: OAuthAuthDetails, skewMs?: number): boolean;
