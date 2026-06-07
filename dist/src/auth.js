import { XAI_ACCESS_TOKEN_REFRESH_SKEW_MS } from "./constants.js";
const REFRESH_PREFIX = "xai:";
export function isOAuthAuth(auth) {
    return auth.type === "oauth";
}
export function packXaiRefresh(parts) {
    const payload = {
        refreshToken: parts.refreshToken,
        tokenEndpoint: parts.tokenEndpoint,
        redirectUri: parts.redirectUri,
    };
    return `${REFRESH_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}
export function parseXaiRefresh(refresh) {
    const value = (refresh ?? "").trim();
    if (!value) {
        return { refreshToken: "" };
    }
    if (!value.startsWith(REFRESH_PREFIX)) {
        return { refreshToken: value };
    }
    try {
        const raw = Buffer.from(value.slice(REFRESH_PREFIX.length), "base64url").toString("utf8");
        const parsed = JSON.parse(raw);
        return {
            refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : "",
            tokenEndpoint: typeof parsed.tokenEndpoint === "string" ? parsed.tokenEndpoint : undefined,
            redirectUri: typeof parsed.redirectUri === "string" ? parsed.redirectUri : undefined,
        };
    }
    catch {
        return { refreshToken: "" };
    }
}
export function calculateTokenExpiry(requestTimeMs, expiresInSeconds, accessToken) {
    if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
        return requestTimeMs + expiresInSeconds * 1000;
    }
    const jwtExpiry = getJwtExpiry(accessToken);
    if (jwtExpiry) {
        return jwtExpiry;
    }
    return requestTimeMs + 3600 * 1000;
}
export function accessTokenExpired(auth, skewMs = XAI_ACCESS_TOKEN_REFRESH_SKEW_MS) {
    if (!auth.access) {
        return true;
    }
    if (typeof auth.expires === "number" && Number.isFinite(auth.expires)) {
        return auth.expires <= Date.now() + skewMs;
    }
    const jwtExpiry = getJwtExpiry(auth.access);
    if (jwtExpiry) {
        return jwtExpiry <= Date.now() + skewMs;
    }
    return false;
}
function getJwtExpiry(token) {
    if (!token || !token.includes(".")) {
        return undefined;
    }
    try {
        const parts = token.split(".");
        const payload = parts[1];
        if (!payload) {
            return undefined;
        }
        const json = Buffer.from(payload, "base64url").toString("utf8");
        const parsed = JSON.parse(json);
        const exp = parsed.exp;
        if (typeof exp !== "number" || !Number.isFinite(exp)) {
            return undefined;
        }
        return exp * 1000;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=auth.js.map