import crypto from "node:crypto";
import {
  PROVIDER_ID,
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_SCOPE,
} from "./constants.js";
import { calculateTokenExpiry } from "./auth.js";
import type { XaiDiscovery, XaiTokenPayload } from "./types.js";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function validateXaiOAuthEndpoint(url: string, field = "endpoint"): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`xAI OAuth discovery returned a non-HTTPS ${field}: ${url}`);
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(
      `xAI OAuth discovery ${field} host ${host} is not on xAI's origin.`,
    );
  }

  return url;
}

export async function discoverXaiOAuth(fetchImpl: typeof fetch = fetch): Promise<XaiDiscovery> {
  const response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
    headers: { 
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
  });

  if (!response.ok) {
    throw new Error(`xAI OIDC discovery failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = String(payload.authorization_endpoint ?? "").trim();
  const tokenEndpoint = String(payload.token_endpoint ?? "").trim();

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("xAI OIDC discovery did not include authorization and token endpoints.");
  }

  return {
    authorizationEndpoint: validateXaiOAuthEndpoint(
      authorizationEndpoint,
      "authorization_endpoint",
    ),
    tokenEndpoint: validateXaiOAuthEndpoint(tokenEndpoint, "token_endpoint"),
  };
}

export function buildXaiAuthorizeUrl(input: {
  authorizationEndpoint: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}): string {
  validateXaiOAuthEndpoint(input.authorizationEndpoint, "authorization_endpoint");

  // Match Hermes Agent's xAI loopback flow exactly. Discovery is still used
  // for token refresh/exchange endpoints, but auth.x.ai currently expects
  // /oauth2/authorize plus the hermes-agent referrer for this public client.
  const url = new URL(XAI_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", XAI_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("plan", "generic");
  url.searchParams.set("referrer", "hermes-agent");
  return url.toString();
}

export async function exchangeXaiCodeForTokens(input: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  codeChallenge: string;
  fetchImpl?: typeof fetch;
}): Promise<XaiTokenPayload> {
  if (!input.codeVerifier) {
    throw new Error("PKCE code verifier is empty.");
  }

  const tokenEndpoint = validateXaiOAuthEndpoint(input.tokenEndpoint, "token_endpoint");
  const startedAt = Date.now();
  const response = await (input.fetchImpl ?? fetch)(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: input.codeVerifier,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  return parseTokenResponse(response, startedAt, "xAI token exchange failed");
}

export async function refreshXaiTokens(input: {
  tokenEndpoint: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<XaiTokenPayload> {
  if (!input.refreshToken) {
    throw new Error("xAI OAuth refresh token is empty.");
  }

  const tokenEndpoint = validateXaiOAuthEndpoint(input.tokenEndpoint, "token_endpoint");
  const startedAt = Date.now();
  const response = await (input.fetchImpl ?? fetch)(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: input.refreshToken,
    }),
  });

  return parseTokenResponse(response, startedAt, "xAI token refresh failed", input.refreshToken);
}

export function parseOAuthCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const raw = input.trim();
  if (!raw) {
    return { error: "Missing authorization code." };
  }

  let code = raw;
  let state = expectedState;

  try {
    const url = new URL(raw);
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      return {
        error: url.searchParams.get("error_description") ?? oauthError,
      };
    }
    code = url.searchParams.get("code") ?? "";
    state = url.searchParams.get("state") ?? "";
  } catch {
    // Plain authorization code. Keep expected state from the local session.
  }

  if (!code) {
    return { error: "Missing authorization code in callback." };
  }
  if (state !== expectedState) {
    return { error: "OAuth state mismatch." };
  }

  return { code, state };
}

async function parseTokenResponse(
  response: Response,
  startedAt: number,
  errorPrefix: string,
  fallbackRefreshToken = "",
): Promise<XaiTokenPayload> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${errorPrefix} (HTTP ${response.status}).${text ? ` Response: ${text}` : ""}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${errorPrefix}: response was not valid JSON.`);
  }

  const accessToken = String(payload.access_token ?? "").trim();
  const refreshToken = String(payload.refresh_token ?? fallbackRefreshToken).trim();
  if (!accessToken) {
    throw new Error(`${errorPrefix}: response did not include access_token.`);
  }
  if (!refreshToken) {
    throw new Error(`${errorPrefix}: response did not include refresh_token.`);
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: calculateTokenExpiry(startedAt, payload.expires_in, accessToken),
    idToken: String(payload.id_token ?? "").trim() || undefined,
    tokenType: String(payload.token_type ?? "Bearer").trim() || "Bearer",
  };
}

export function createOAuthState(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function createOAuthNonce(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function tokenResultToAuthResult(input: {
  accessToken: string;
  refresh: string;
  expiresAt: number;
}) {
  return {
    type: "success" as const,
    provider: PROVIDER_ID,
    refresh: input.refresh,
    access: input.accessToken,
    expires: input.expiresAt,
  };
}
