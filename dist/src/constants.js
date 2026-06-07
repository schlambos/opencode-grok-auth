export const PROVIDER_ID = "xai-oauth";
export const PROVIDER_NAME = "xAI Grok OAuth";
export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
// Public desktop OAuth client ID used by the Grok CLI flow. This is not a secret.
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
export const XAI_ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;
export const OAUTH_CALLBACK_TIMEOUT_MS = 180_000;
export const DEFAULT_XAI_MODELS = [
    "grok-4.3",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-multi-agent-0309",
];
// --- Grok Build / Composer (cli-chat-proxy backend) ---
// Composer is NOT served by the public xAI API (api.x.ai). It lives on the
// Grok Build / Grok CLI backend, which is OpenAI-compatible at this base URL.
export const COMPOSER_PROVIDER_ID = "xai-composer";
export const COMPOSER_PROVIDER_NAME = "xAI Grok Composer (OAuth)";
export const CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// The proxy routes to the correct inference cluster via this header (not the
// JSON body). "Always safe to include" per the Grok CLI's own docs.
export const GROK_CLIENT_VERSION = "0.2.32";
export const GROK_CLIENT_IDENTIFIER = "xai-grok-cli";
// Hosts the OAuth bearer token may be sent to:
//   api.x.ai              -> public xAI API (grok-4.x, etc.)
//   cli-chat-proxy.grok.com -> Grok Build backend (Composer, grok-build)
export const SAFE_XAI_API_HOSTS = ["api.x.ai", "cli-chat-proxy.grok.com"];
// Auth-store provider keys to import an existing Grok OAuth token from when the
// composer provider has no credential of its own yet (mirrors allstatus.ts:
// `a["xai-oauth"] ?? a.xai`). Lets Composer work without a second login.
export const SHARED_OAUTH_AUTH_KEYS = ["xai-oauth", "xai"];
export const DEFAULT_COMPOSER_MODELS = ["grok-composer-2.5-fast"];
//# sourceMappingURL=constants.js.map