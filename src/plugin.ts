import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import {
  CLI_CHAT_PROXY_BASE_URL,
  COMPOSER_PROVIDER_ID,
  COMPOSER_PROVIDER_NAME,
  DEFAULT_COMPOSER_MODELS,
  DEFAULT_XAI_MODELS,
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_VERSION,
  OAUTH_CALLBACK_TIMEOUT_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  SAFE_XAI_API_HOSTS,
  SHARED_OAUTH_AUTH_KEYS,
  XAI_API_BASE_URL,
} from "./constants.js";
import { accessTokenExpired, isOAuthAuth, packXaiRefresh, parseXaiRefresh } from "./auth.js";
import {
  buildXaiAuthorizeUrl,
  createOAuthNonce,
  createOAuthState,
  discoverXaiOAuth,
  exchangeXaiCodeForTokens,
  generatePkce,
  parseOAuthCallbackInput,
  refreshXaiTokens,
  tokenResultToAuthResult,
} from "./oauth.js";
import { startXaiOAuthListener } from "./server.js";
import type {
  AuthDetails,
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  Provider,
  XaiGrokPluginOptions,
  XaiTokenExchangeResult,
} from "./types.js";

type StoredOAuthAuthDetails = OAuthAuthDetails & {
  access: string;
  expires: number;
};

export function createXaiGrokOAuthPlugin(
  providerId = PROVIDER_ID,
  options: XaiGrokPluginOptions = {},
): Plugin {
  const baseURL = options.baseURL ?? XAI_API_BASE_URL;
  const providerName = options.providerName ?? PROVIDER_NAME;
  const models = options.models ?? DEFAULT_XAI_MODELS;
  const injectModelOverride = options.injectModelOverride ?? false;
  const importTokenFrom = options.importTokenFrom ?? [];

  const plugin: Plugin = async ({ client }) => {
    return {
      config: async (config) => {
        applyDefaultProviderConfig(config, providerId, { baseURL, providerName, models });
        // Seed a dedicated provider (e.g. xai-composer) with an existing Grok
        // OAuth token so it works without a second login.
        if (importTokenFrom.length) {
          await seedSharedAuth(client, providerId, importTokenFrom);
        }
      },
      auth: {
        provider: providerId,
        async loader(getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, never>> {
          const auth = await resolveAuth(getAuth, client, providerId, importTokenFrom);
          if (!isOAuthAuth(auth)) {
            return {};
          }

          if (provider.models) {
            for (const model of Object.values(provider.models)) {
              model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
            }
          }

          return {
            apiKey: auth.access ?? "",
            baseURL,
            async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
              const latest = await resolveAuth(getAuth, client, providerId, importTokenFrom);
              if (!isOAuthAuth(latest)) {
                return fetch(input, init);
              }

              const modelOverride = injectModelOverride ? extractModelId(init) : undefined;
              const freshAuth = await ensureFreshAuth(latest, client, providerId);
              const request = buildBearerRequest(input, init, freshAuth.access ?? "", { modelOverride });
              const retrySeed = request.clone();
              let response = await fetch(request);

              if (response.status === 401) {
                const refreshed = await refreshStoredAuth(freshAuth, client, providerId);
                response = await fetch(
                  buildBearerRequest(retrySeed, undefined, refreshed.access, { modelOverride }),
                );
              }

              return response;
            },
          };
        },
        methods: [
          {
            label: "OAuth with xAI Grok (SuperGrok)",
            type: "oauth",
            async authorize(): Promise<{
              url: string;
              instructions: string;
              method: "auto";
              callback: () => Promise<XaiTokenExchangeResult>;
            }> {
              const discovery = await discoverXaiOAuth();
              const listener = await startXaiOAuthListener();
              const pkce = generatePkce();
              const state = createOAuthState();
              const nonce = createOAuthNonce();
              const authorizationUrl = buildXaiAuthorizeUrl({
                authorizationEndpoint: discovery.authorizationEndpoint,
                redirectUri: listener.redirectUri,
                codeChallenge: pkce.challenge,
                state,
                nonce,
              });

              const browserOpened = shouldOpenBrowser() ? await openBrowser(authorizationUrl) : false;
              const instructions = [
                browserOpened
                  ? "Complete sign-in in your browser. OpenCode will capture the xAI callback locally."
                  : "Open the OAuth URL and complete xAI sign-in.",
                "",
                authorizationUrl,
                "",
                `Callback listener: ${listener.redirectUri}`,
                "If this is a remote shell, forward the callback port to this machine first.",
              ].join("\n");

              return {
                url: authorizationUrl,
                instructions,
                method: "auto",
                callback: async (): Promise<XaiTokenExchangeResult> => {
                  try {
                    const callbackUrl = await listener.waitForCallback(OAUTH_CALLBACK_TIMEOUT_MS);
                    const params = parseOAuthCallbackInput(callbackUrl.toString(), state);
                    if ("error" in params) {
                      return { type: "failed", error: params.error };
                    }

                    const tokenPayload = await exchangeXaiCodeForTokens({
                      tokenEndpoint: discovery.tokenEndpoint,
                      code: params.code,
                      redirectUri: listener.redirectUri,
                      codeVerifier: pkce.verifier,
                      codeChallenge: pkce.challenge,
                    });

                    const refresh = packXaiRefresh({
                      refreshToken: tokenPayload.refreshToken,
                      tokenEndpoint: discovery.tokenEndpoint,
                      redirectUri: listener.redirectUri,
                    });

                    return tokenResultToAuthResult({
                      accessToken: tokenPayload.accessToken,
                      refresh,
                      expiresAt: tokenPayload.expiresAt,
                    });
                  } catch (error) {
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : String(error),
                    };
                  } finally {
                    await listener.close().catch(() => undefined);
                  }
                },
              };
            },
          },
        ],
      },
    };
  };

  return plugin;
}

export const XaiGrokOAuthPlugin = createXaiGrokOAuthPlugin();
export default XaiGrokOAuthPlugin;

/**
 * Dedicated provider for Composer 2.5, served by the Grok Build backend
 * (cli-chat-proxy.grok.com) rather than the public xAI API. Reuses an existing
 * Grok OAuth token (imported from the `xai-oauth`/`xai` auth entries) so no
 * second login is required, and injects `x-grok-model-override` for routing.
 */
export function createXaiComposerOAuthPlugin(providerId = COMPOSER_PROVIDER_ID): Plugin {
  return createXaiGrokOAuthPlugin(providerId, {
    baseURL: CLI_CHAT_PROXY_BASE_URL,
    providerName: COMPOSER_PROVIDER_NAME,
    models: DEFAULT_COMPOSER_MODELS,
    injectModelOverride: true,
    importTokenFrom: SHARED_OAUTH_AUTH_KEYS,
  });
}

export const XaiComposerOAuthPlugin = createXaiComposerOAuthPlugin();

export function applyDefaultProviderConfig(
  config: unknown,
  providerId = PROVIDER_ID,
  opts: { baseURL?: string; providerName?: string; models?: readonly string[] } = {},
): void {
  if (process.env.OPENCODE_XAI_OAUTH_AUTO_CONFIG === "false") {
    return;
  }
  if (!config || typeof config !== "object") {
    return;
  }

  const root = config as Record<string, unknown>;
  const providers = getOrCreateRecord(root, "provider");
  const provider = getOrCreateRecord(providers, providerId);

  provider.npm ??= "@ai-sdk/openai";
  provider.name ??= opts.providerName ?? PROVIDER_NAME;

  const options = getOrCreateRecord(provider, "options");
  options.baseURL ??= opts.baseURL ?? XAI_API_BASE_URL;

  const models = getOrCreateRecord(provider, "models");
  for (const model of opts.models ?? DEFAULT_XAI_MODELS) {
    const existing = models[model];
    if (!existing || typeof existing !== "object") {
      models[model] = { name: model };
    }
  }
}

async function ensureFreshAuth(
  auth: OAuthAuthDetails,
  client: PluginClient | undefined,
  providerId: string,
): Promise<OAuthAuthDetails> {
  if (!accessTokenExpired(auth)) {
    return auth;
  }
  return refreshStoredAuth(auth, client, providerId);
}

async function refreshStoredAuth(
  auth: OAuthAuthDetails,
  client: PluginClient | undefined,
  providerId: string,
): Promise<StoredOAuthAuthDetails> {
  const parts = parseXaiRefresh(auth.refresh);
  if (!parts.refreshToken) {
    throw new Error("xAI OAuth refresh token is missing. Run `opencode auth login` again.");
  }

  const tokenEndpoint = parts.tokenEndpoint ?? (await discoverXaiOAuth()).tokenEndpoint;
  const refreshed = await refreshXaiTokens({
    tokenEndpoint,
    refreshToken: parts.refreshToken,
  });

  const nextAuth: StoredOAuthAuthDetails = {
    type: "oauth",
    refresh: packXaiRefresh({
      refreshToken: refreshed.refreshToken,
      tokenEndpoint,
      redirectUri: parts.redirectUri,
    }),
    access: refreshed.accessToken,
    expires: refreshed.expiresAt,
  };

  if (client) {
    await client.auth.set({
      path: { id: providerId },
      body: {
        type: "oauth",
        refresh: nextAuth.refresh,
        access: nextAuth.access,
        expires: nextAuth.expires,
      },
    });
  }

  return nextAuth;
}

function buildBearerRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  opts: { modelOverride?: string } = {},
): Request {
  if (!accessToken) {
    throw new Error("xAI OAuth access token is missing. Run `opencode auth login` again.");
  }

  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!isSafeXaiApiUrl(url)) {
    throw new Error(`Refusing to send xAI OAuth token to non-xAI URL: ${url.origin}`);
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  if (!headers.has("x-grok-source")) {
    headers.set("x-grok-source", "opencode-grok-auth");
  }

  // Route to the correct inference cluster on the Grok Build proxy (Composer).
  if (opts.modelOverride) {
    headers.set("x-grok-model-override", opts.modelOverride);
    if (!headers.has("x-grok-client-version")) {
      headers.set("x-grok-client-version", GROK_CLIENT_VERSION);
    }
    if (!headers.has("x-grok-client-identifier")) {
      headers.set("x-grok-client-identifier", GROK_CLIENT_IDENTIFIER);
    }
  }

  return new Request(request, { headers });
}

export function isSafeXaiApiUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (SAFE_XAI_API_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())
  );
}

/** Extract the `model` field from an outgoing chat-completions request body. */
function extractModelId(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the OAuth credential for this provider, falling back to an existing
 * Grok token (xai-oauth/xai) when the provider has none of its own. Lets the
 * Composer provider reuse an already-authenticated token without a second login.
 */
async function resolveAuth(
  getAuth: GetAuth,
  client: PluginClient | undefined,
  providerId: string,
  importTokenFrom: readonly string[],
): Promise<AuthDetails> {
  const auth = await getAuth();
  if (isOAuthAuth(auth) || importTokenFrom.length === 0) {
    return auth;
  }
  const imported = readSharedOAuth(importTokenFrom);
  if (imported) {
    await persistAuth(client, providerId, imported).catch(() => undefined);
    return imported;
  }
  return auth;
}

/** Seed this provider's auth from an existing Grok token if it has none yet. */
async function seedSharedAuth(
  client: PluginClient | undefined,
  providerId: string,
  importTokenFrom: readonly string[],
): Promise<void> {
  try {
    const store = readAuthStore();
    if (!store) {
      return;
    }
    const existing = store[providerId] as { type?: string; access?: string } | undefined;
    if (existing && existing.type === "oauth" && existing.access) {
      return; // already authenticated under this provider id
    }
    const imported = pickSharedOAuth(store, importTokenFrom);
    if (imported) {
      await persistAuth(client, providerId, imported);
    }
  } catch {
    // best-effort: a missing/locked store should never block startup
  }
}

function readSharedOAuth(keys: readonly string[]): StoredOAuthAuthDetails | undefined {
  const store = readAuthStore();
  return store ? pickSharedOAuth(store, keys) : undefined;
}

function pickSharedOAuth(
  store: Record<string, unknown>,
  keys: readonly string[],
): StoredOAuthAuthDetails | undefined {
  for (const key of keys) {
    const entry = store[key] as
      | { type?: string; refresh?: string; access?: string; expires?: number }
      | undefined;
    if (entry && entry.type === "oauth" && typeof entry.refresh === "string" && entry.refresh) {
      return {
        type: "oauth",
        refresh: entry.refresh,
        access: typeof entry.access === "string" ? entry.access : "",
        expires: typeof entry.expires === "number" ? entry.expires : 0,
      };
    }
  }
  return undefined;
}

async function persistAuth(
  client: PluginClient | undefined,
  providerId: string,
  auth: StoredOAuthAuthDetails,
): Promise<void> {
  if (!client) {
    return;
  }
  await client.auth.set({
    path: { id: providerId },
    body: { type: "oauth", refresh: auth.refresh, access: auth.access, expires: auth.expires },
  });
}

function authStorePath(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "opencode", "auth.json");
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

function readAuthStore(): Record<string, unknown> | undefined {
  try {
    const file = authStorePath();
    if (!fs.existsSync(file)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function getOrCreateRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function shouldOpenBrowser(): boolean {
  if (process.env.OPENCODE_XAI_OAUTH_NO_BROWSER === "1") {
    return false;
  }
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return false;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return false;
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

function openBrowser(url: string): Promise<boolean> {
  const command = browserCommand(url);
  if (!command) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function browserCommand(url: string): { file: string; args: string[] } | undefined {
  if (process.platform === "darwin") {
    return { file: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { file: "explorer.exe", args: [url] };
  }
  return { file: "xdg-open", args: [url] };
}
