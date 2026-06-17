import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_CHAT_PROXY_BASE_URL, COMPOSER_MODEL_PREFIXES, COMPOSER_PROVIDER_ID, COMPOSER_PROVIDER_NAME, DEFAULT_COMPOSER_MODELS, DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_OUTPUT_TOKENS, DEFAULT_XAI_MODELS, GROK_CLIENT_IDENTIFIER, GROK_CLIENT_VERSION, MEDIA_MODEL_DENYLIST_PREFIXES, OAUTH_CALLBACK_TIMEOUT_MS, OPENAI_MODELS_PATH, PROVIDER_ID, PROVIDER_NAME, SAFE_XAI_API_HOSTS, SHARED_OAUTH_AUTH_KEYS, UNIFIED_PROVIDER_NAME, XAI_API_BASE_URL, XAI_DYNAMIC_MODELS_ENV, XAI_LANGUAGE_MODELS_PATH, XAI_MODELS_CACHE_FILE, XAI_MODELS_CACHE_TTL_MS, XAI_MODELS_CACHE_VERSION, XAI_MODELS_FETCH_TIMEOUT_MS, } from "./constants.js";
import { accessTokenExpired, isOAuthAuth, packXaiRefresh, parseXaiRefresh } from "./auth.js";
import { buildXaiAuthorizeUrl, createOAuthNonce, createOAuthState, discoverXaiOAuth, exchangeXaiCodeForTokens, generatePkce, parseOAuthCallbackInput, refreshXaiTokens, tokenResultToAuthResult, } from "./oauth.js";
import { startXaiOAuthListener } from "./server.js";
export function createXaiGrokOAuthPlugin(providerId = PROVIDER_ID, options = {}) {
    const mergeComposerBackend = options.mergeComposerBackend ?? false;
    const baseURL = options.baseURL ?? XAI_API_BASE_URL;
    const providerName = options.providerName ?? (mergeComposerBackend ? UNIFIED_PROVIDER_NAME : PROVIDER_NAME);
    const defaultModels = mergeComposerBackend
        ? [...DEFAULT_XAI_MODELS, ...DEFAULT_COMPOSER_MODELS]
        : DEFAULT_XAI_MODELS;
    const models = options.models ?? defaultModels;
    const injectModelOverride = options.injectModelOverride ?? false;
    const importTokenFrom = options.importTokenFrom ?? [];
    // Two-provider design:
    //   - Public xAI API (api.x.ai):     /language-models, no override
    //   - Grok Build proxy (composer):    /models, override
    const dynamicModels = options.dynamicModels ?? true;
    const modelListPath = options.modelListPath ??
        (baseURL === CLI_CHAT_PROXY_BASE_URL ? OPENAI_MODELS_PATH : XAI_LANGUAGE_MODELS_PATH);
    const modelListKind = options.modelListKind ??
        (baseURL === CLI_CHAT_PROXY_BASE_URL ? "openai-models" : "xai-language-models");
    const alwaysIncludeModels = options.alwaysIncludeModels ?? (mergeComposerBackend ? DEFAULT_COMPOSER_MODELS : []);
    const modelCacheTtlMs = options.modelCacheTtlMs ?? XAI_MODELS_CACHE_TTL_MS;
    const modelFetchTimeoutMs = options.modelFetchTimeoutMs ?? XAI_MODELS_FETCH_TIMEOUT_MS;
    const modelAuthKeys = dedupe([
        ...(options.modelAuthKeys ?? []),
        providerId,
        ...importTokenFrom,
        ...SHARED_OAUTH_AUTH_KEYS,
    ]);
    // Keys that should stay in lockstep with this provider's OAuth token.
    // xAI rotates refresh_token on every refresh, so if we only write back to
    // our own providerId entry the sibling entries (e.g. xai-composer vs
    // xai-oauth) instantly hold a revoked refresh token and start failing.
    const tokenSyncKeys = dedupe([providerId, ...importTokenFrom, ...SHARED_OAUTH_AUTH_KEYS]);
    const plugin = async ({ client }) => {
        return {
            "experimental.chat.system.transform": async (input, output) => {
                // Grok models frequently hallucinate "todo_write" instead of "todowrite".
                // Inject a targeted reminder to prevent this tool-call failure.
                const modelStr = typeof input.model === "string" ? input.model : JSON.stringify(input.model || {});
                if (modelStr.toLowerCase().includes("grok")) {
                    output.system.push("CRITICAL TOOL NAMING RULE: You must use the exact name `todowrite` (no underscore) for the todo tool. Never use `todo_write`.");
                }
            },
            config: async (config) => {
                if (!shouldAutoConfigure()) {
                    return;
                }
                await syncToNewestSharedAuth(client, providerId, tokenSyncKeys);
                if (mergeComposerBackend) {
                    // Unified mode supersedes the standalone Composer provider. Strip
                    // its config entry and stale auth.json record so OpenCode stops
                    // surfacing it as a separate provider.
                    removeLegacyProviderConfig(config, COMPOSER_PROVIDER_ID);
                    removeLegacyAuthEntry(COMPOSER_PROVIDER_ID);
                }
                const modelDefaults = await resolveModelDefaultsForConfig({
                    client,
                    providerId,
                    baseURL,
                    staticModels: models,
                    dynamicModels,
                    modelListPath,
                    modelListKind,
                    alwaysIncludeModels,
                    modelCacheTtlMs,
                    modelFetchTimeoutMs,
                    modelAuthKeys,
                    injectGrokClientHeaders: injectModelOverride,
                    mergeComposerBackend,
                    config,
                });
                applyDefaultProviderConfig(config, providerId, {
                    baseURL,
                    providerName,
                    models: modelDefaults,
                });
            },
            auth: {
                provider: providerId,
                async loader(getAuth, provider) {
                    const auth = await resolveAuth(getAuth, client, providerId, importTokenFrom, tokenSyncKeys);
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
                        async fetch(input, init) {
                            const latest = await resolveAuth(getAuth, client, providerId, importTokenFrom, tokenSyncKeys);
                            if (!isOAuthAuth(latest)) {
                                return fetch(input, init);
                            }
                            const modelId = extractModelId(init);
                            const routeComposer = mergeComposerBackend && isComposerRoutedModel(modelId);
                            // In unified mode, requests for composer/build models are
                            // rewritten to the Grok Build proxy host. The model-override
                            // header tells the proxy which Composer cluster to dispatch to.
                            const effectiveInput = routeComposer ? rewriteToComposerHost(input) : input;
                            const modelOverride = routeComposer || injectModelOverride ? modelId : undefined;
                            const includeGrokClientHeaders = routeComposer || injectModelOverride;
                            const freshAuth = await ensureFreshAuth(latest, client, providerId, tokenSyncKeys);
                            const request = buildBearerRequest(effectiveInput, init, freshAuth.access ?? "", {
                                modelOverride,
                                includeGrokClientHeaders,
                            });
                            const retrySeed = request.clone();
                            let response = await fetch(request);
                            if (response.status === 401) {
                                const refreshed = await refreshStoredAuth(freshAuth, client, providerId, tokenSyncKeys);
                                response = await fetch(buildBearerRequest(retrySeed, undefined, refreshed.access, {
                                    modelOverride,
                                    includeGrokClientHeaders,
                                }));
                            }
                            return withStreamIdleTimeout(response);
                        },
                    };
                },
                methods: [
                    {
                        label: "OAuth with xAI Grok (SuperGrok)",
                        type: "oauth",
                        async authorize() {
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
                                callback: async () => {
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
                                    }
                                    catch (error) {
                                        return {
                                            type: "failed",
                                            error: error instanceof Error ? error.message : String(error),
                                        };
                                    }
                                    finally {
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
export function createXaiComposerOAuthPlugin(providerId = COMPOSER_PROVIDER_ID) {
    return createXaiGrokOAuthPlugin(providerId, {
        baseURL: CLI_CHAT_PROXY_BASE_URL,
        providerName: COMPOSER_PROVIDER_NAME,
        models: DEFAULT_COMPOSER_MODELS,
        injectModelOverride: true,
        importTokenFrom: SHARED_OAUTH_AUTH_KEYS,
        modelListPath: OPENAI_MODELS_PATH,
        modelListKind: "openai-models",
        alwaysIncludeModels: DEFAULT_COMPOSER_MODELS,
    });
}
export const XaiComposerOAuthPlugin = createXaiComposerOAuthPlugin();
/**
 * Single unified provider that surfaces BOTH Grok models (api.x.ai) and
 * Composer/Build models (cli-chat-proxy.grok.com) under one entry in
 * OpenCode's provider list. Routing is per-request, based on model id.
 */
export function createXaiUnifiedOAuthPlugin(providerId = PROVIDER_ID) {
    return createXaiGrokOAuthPlugin(providerId, {
        mergeComposerBackend: true,
        importTokenFrom: SHARED_OAUTH_AUTH_KEYS,
    });
}
export const XaiUnifiedOAuthPlugin = createXaiUnifiedOAuthPlugin();
export function applyDefaultProviderConfig(config, providerId = PROVIDER_ID, opts = {}) {
    if (process.env.OPENCODE_XAI_OAUTH_AUTO_CONFIG === "false") {
        return;
    }
    if (!config || typeof config !== "object") {
        return;
    }
    const root = config;
    const providers = getOrCreateRecord(root, "provider");
    const provider = getOrCreateRecord(providers, providerId);
    provider.npm ??= "@ai-sdk/openai";
    provider.name ??= opts.providerName ?? PROVIDER_NAME;
    const options = getOrCreateRecord(provider, "options");
    options.baseURL ??= opts.baseURL ?? XAI_API_BASE_URL;
    const models = getOrCreateRecord(provider, "models");
    for (const entry of opts.models ?? DEFAULT_XAI_MODELS) {
        const id = typeof entry === "string" ? entry : entry.id;
        const value = typeof entry === "string" ? { name: entry } : entry.model;
        const existing = models[id];
        if (!existing || typeof existing !== "object") {
            models[id] = value;
        }
    }
}
async function ensureFreshAuth(auth, client, providerId, syncKeys) {
    if (!accessTokenExpired(auth)) {
        return auth;
    }
    return refreshStoredAuth(auth, client, providerId, syncKeys);
}
/** Reusable token-endpoint refresh: parses the packed refresh, calls the
 *  OAuth token endpoint, and returns the new stored auth details. Does NOT
 *  persist the new credentials. */
async function refreshOAuthAuth(auth) {
    const parts = parseXaiRefresh(auth.refresh);
    if (!parts.refreshToken) {
        throw new Error("xAI OAuth refresh token is missing. Run `opencode auth login` again.");
    }
    const tokenEndpoint = parts.tokenEndpoint ?? (await discoverXaiOAuth()).tokenEndpoint;
    const refreshed = await refreshXaiTokens({
        tokenEndpoint,
        refreshToken: parts.refreshToken,
    });
    return {
        type: "oauth",
        refresh: packXaiRefresh({
            refreshToken: refreshed.refreshToken,
            tokenEndpoint,
            redirectUri: parts.redirectUri,
        }),
        access: refreshed.accessToken,
        expires: refreshed.expiresAt,
    };
}
async function refreshStoredAuth(auth, client, providerId, syncKeys) {
    const nextAuth = await refreshOAuthAuth(auth);
    await persistAuthBroadcast(client, providerId, syncKeys, nextAuth).catch(() => undefined);
    return nextAuth;
}
function buildBearerRequest(input, init, accessToken, opts = {}) {
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
    // Inject Grok client headers whenever we are routing through the Build
    // proxy (composer model-list fetch) or per-request routing a Composer
    // chat request via x-grok-model-override.
    if (opts.modelOverride || opts.includeGrokClientHeaders) {
        if (opts.modelOverride) {
            headers.set("x-grok-model-override", opts.modelOverride);
        }
        if (!headers.has("x-grok-client-version")) {
            headers.set("x-grok-client-version", GROK_CLIENT_VERSION);
        }
        if (!headers.has("x-grok-client-identifier")) {
            headers.set("x-grok-client-identifier", GROK_CLIENT_IDENTIFIER);
        }
    }
    return new Request(request, { headers });
}
export function isSafeXaiApiUrl(url) {
    return (url.protocol === "https:" &&
        SAFE_XAI_API_HOSTS.includes(url.hostname.toLowerCase()));
}
function isComposerRoutedModel(modelId) {
    if (!modelId) {
        return false;
    }
    for (const prefix of COMPOSER_MODEL_PREFIXES) {
        if (modelId.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}
/**
 * Replace the host of an outgoing request URL with the Grok Build proxy host,
 * preserving path, query, headers, and body. Used in unified mode when a
 * composer/build model is selected.
 */
function rewriteToComposerHost(input) {
    const composerHost = new URL(CLI_CHAT_PROXY_BASE_URL).host;
    if (typeof input === "string") {
        const url = new URL(input);
        url.host = composerHost;
        url.protocol = "https:";
        return url.toString();
    }
    if (input instanceof URL) {
        const url = new URL(input.toString());
        url.host = composerHost;
        url.protocol = "https:";
        return url;
    }
    // Request
    const url = new URL(input.url);
    url.host = composerHost;
    url.protocol = "https:";
    return new Request(url.toString(), input);
}
/** Extract the `model` field from an outgoing chat-completions request body. */
function extractModelId(init) {
    const body = init?.body;
    if (typeof body !== "string") {
        return undefined;
    }
    try {
        const parsed = JSON.parse(body);
        return typeof parsed.model === "string" ? parsed.model : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve the OAuth credential for this provider. Adopts the newest oauth
 * entry across the sync-key set so a refresh performed by a sibling provider
 * (e.g. xai-oauth) immediately propagates to this one. Without this, xAI's
 * refresh_token rotation revokes the sibling's stale token within ~24h.
 */
async function resolveAuth(getAuth, client, providerId, importTokenFrom, syncKeys) {
    const auth = await getAuth();
    if (syncKeys.length === 0) {
        return auth;
    }
    const newest = readNewestSharedOAuth(syncKeys);
    if (!newest) {
        return auth;
    }
    if (!isOAuthAuth(auth) || isNewerOAuth(newest, auth)) {
        await persistAuthBroadcast(client, providerId, syncKeys, newest).catch(() => undefined);
        return newest;
    }
    // Our entry is the freshest — push it out so siblings stay in lockstep.
    await persistAuthBroadcast(client, providerId, syncKeys, {
        type: "oauth",
        refresh: auth.refresh,
        access: auth.access ?? "",
        expires: typeof auth.expires === "number" ? auth.expires : 0,
    }).catch(() => undefined);
    return auth;
}
/** Adopt the newest oauth entry across the sync set into this provider id. */
async function syncToNewestSharedAuth(client, providerId, syncKeys) {
    try {
        const newest = readNewestSharedOAuth(syncKeys);
        if (newest) {
            await persistAuthBroadcast(client, providerId, syncKeys, newest);
        }
    }
    catch {
        // best-effort: a missing/locked store should never block startup
    }
}
function readSharedOAuth(keys) {
    const store = readAuthStore();
    return store ? pickSharedOAuth(store, keys) : undefined;
}
function pickSharedOAuth(store, keys) {
    for (const key of keys) {
        const entry = store[key];
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
/** Return the oauth entry with the highest expires across the sync set. */
function readNewestSharedOAuth(keys) {
    const store = readAuthStore();
    if (!store) {
        return undefined;
    }
    let best;
    for (const key of keys) {
        const entry = store[key];
        if (!entry || entry.type !== "oauth" || typeof entry.refresh !== "string" || !entry.refresh) {
            continue;
        }
        const candidate = {
            type: "oauth",
            refresh: entry.refresh,
            access: typeof entry.access === "string" ? entry.access : "",
            expires: typeof entry.expires === "number" ? entry.expires : 0,
        };
        if (!best || candidate.expires > best.expires) {
            best = candidate;
        }
    }
    return best;
}
function isNewerOAuth(a, b) {
    const aExp = typeof a.expires === "number" ? a.expires : 0;
    const bExp = typeof b.expires === "number" ? b.expires : 0;
    if (aExp !== bExp) {
        return aExp > bExp;
    }
    return a.refresh !== b.refresh;
}
/**
 * Persist auth to providerId and to every sync key that already exists as an
 * oauth entry. Never creates non-oauth entries from scratch, so we won't
 * clobber an api-key entry under `xai`.
 */
async function persistAuthBroadcast(client, providerId, syncKeys, auth) {
    if (!client) {
        return;
    }
    const store = readAuthStore();
    const targets = new Set([providerId]);
    if (store) {
        for (const key of syncKeys) {
            const entry = store[key];
            if (entry?.type === "oauth") {
                targets.add(key);
            }
        }
    }
    await Promise.all(Array.from(targets).map((id) => client.auth
        .set({
        path: { id },
        body: { type: "oauth", refresh: auth.refresh, access: auth.access, expires: auth.expires },
    })
        .catch(() => undefined)));
}
function removeLegacyProviderConfig(config, legacyId) {
    if (!config || typeof config !== "object") {
        return;
    }
    const root = config;
    const provider = root.provider;
    if (provider && Object.prototype.hasOwnProperty.call(provider, legacyId)) {
        delete provider[legacyId];
    }
}
/**
 * Atomically remove `legacyId` from the auth.json store. The opencode SDK
 * exposes only `auth.set` (no delete), so we edit the file directly with
 * a temp-file + rename. Best-effort: errors are swallowed.
 */
function removeLegacyAuthEntry(legacyId) {
    try {
        const file = authStorePath();
        if (!fs.existsSync(file)) {
            return;
        }
        const raw = fs.readFileSync(file, "utf8");
        let store;
        try {
            store = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(store, legacyId)) {
            return;
        }
        delete store[legacyId];
        const tempFile = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(store, null, 2), "utf8");
        fs.renameSync(tempFile, file);
    }
    catch {
        // best-effort: never break startup
    }
}
function authStorePath() {
    if (process.platform === "win32" && process.env.APPDATA) {
        return path.join(process.env.APPDATA, "opencode", "auth.json");
    }
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return path.join(dataHome, "opencode", "auth.json");
}
function readAuthStore() {
    try {
        const file = authStorePath();
        if (!fs.existsSync(file)) {
            return undefined;
        }
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
function getOrCreateRecord(parent, key) {
    const current = parent[key];
    if (current && typeof current === "object" && !Array.isArray(current)) {
        return current;
    }
    const next = {};
    parent[key] = next;
    return next;
}
// ---------------------------------------------------------------------------
// Dynamic model-list resolution
// ---------------------------------------------------------------------------
/** True when the user has not opted out of the plugin's auto-config. */
function shouldAutoConfigure() {
    return process.env.OPENCODE_XAI_OAUTH_AUTO_CONFIG !== "false";
}
/** True when the dynamic model-list fetch is enabled. */
function dynamicModelsEnabled() {
    return process.env[XAI_DYNAMIC_MODELS_ENV] !== "false";
}
/**
 * If the user already set `provider[providerId].options.baseURL` in their
 * config and it differs from the base URL this instance is using, skip
 * the dynamic fetch — we cannot assume the user's override is on the same
 * backend as ours.
 */
function isProviderBaseUrlCompatible(config, providerId, baseURL) {
    if (!config || typeof config !== "object") {
        return true;
    }
    const root = config;
    const provider = (root.provider ?? undefined);
    if (!provider) {
        return true;
    }
    const entry = provider[providerId];
    if (!entry || typeof entry !== "object") {
        return true;
    }
    const options = entry.options;
    if (!options || typeof options !== "object") {
        return true;
    }
    const userBaseURL = options.baseURL;
    if (typeof userBaseURL !== "string" || userBaseURL.length === 0) {
        return true;
    }
    return userBaseURL === baseURL;
}
/** Resolve a valid OAuth credential for the dynamic model-list fetch. */
async function resolveConfigOAuthAuth(input) {
    const store = readAuthStore();
    if (!store) {
        return undefined;
    }
    const auth = pickSharedOAuth(store, input.authKeys);
    if (!auth) {
        return undefined;
    }
    if (!accessTokenExpired(auth)) {
        return auth;
    }
    const refreshed = await refreshOAuthAuth(auth).catch(() => undefined);
    if (!refreshed) {
        return undefined;
    }
    await persistAuthBroadcast(input.client, input.providerId, input.authKeys, refreshed).catch(() => undefined);
    return refreshed;
}
async function resolveModelDefaultsForConfig(input) {
    const staticDefaults = input.staticModels.map((id) => ({
        id,
        model: { name: id },
    }));
    if (!dynamicModelsEnabled()) {
        return input.staticModels;
    }
    if (!input.dynamicModels) {
        return input.staticModels;
    }
    if (!isProviderBaseUrlCompatible(input.config, input.providerId, input.baseURL)) {
        return input.staticModels;
    }
    const cache = readModelCache(input.providerId, input.baseURL, input.modelListPath);
    if (cache && isModelCacheFresh(cache, input.modelCacheTtlMs)) {
        return unionAlwaysInclude(cache.models, input.alwaysIncludeModels);
    }
    const auth = await resolveConfigOAuthAuth({
        client: input.client,
        providerId: input.providerId,
        authKeys: input.modelAuthKeys,
    });
    if (!auth) {
        return cache?.models ?? staticDefaults;
    }
    try {
        // resolveConfigOAuthAuth already returns a non-expired auth (refreshing
        // if needed), so the call below is a defensive re-check.
        const freshAuth = await ensureFreshAuth(auth, input.client, input.providerId, input.modelAuthKeys);
        const fetched = await fetchDynamicModels({
            baseURL: input.baseURL,
            endpointPath: input.modelListPath,
            kind: input.modelListKind,
            auth: freshAuth,
            timeoutMs: input.modelFetchTimeoutMs,
            includeGrokClientHeaders: input.injectGrokClientHeaders,
        });
        if (input.mergeComposerBackend) {
            // Also pull the Grok Build proxy model list so composer/build models
            // show up under this single unified provider.
            const composerFetched = await fetchDynamicModels({
                baseURL: CLI_CHAT_PROXY_BASE_URL,
                endpointPath: OPENAI_MODELS_PATH,
                kind: "openai-models",
                auth: freshAuth,
                timeoutMs: input.modelFetchTimeoutMs,
                includeGrokClientHeaders: true,
            }).catch(() => []);
            const seen = new Set(fetched.map((m) => m.id));
            for (const m of composerFetched) {
                if (!seen.has(m.id)) {
                    seen.add(m.id);
                    fetched.push(m);
                }
            }
        }
        const merged = unionAlwaysInclude(fetched, input.alwaysIncludeModels);
        if (merged.length === 0) {
            throw new Error("Dynamic model list was empty after filtering.");
        }
        writeModelCache(input.providerId, input.baseURL, input.modelListPath, merged);
        return merged;
    }
    catch {
        return cache?.models ?? staticDefaults;
    }
}
function fetchDynamicModels(input) {
    // String-concat join (NOT `new URL(endpointPath, baseURL)`): because
    // endpointPath starts with `/` (e.g. `/language-models` or `/models`), the
    // URL constructor resolves it against the host ROOT and silently drops the
    // baseURL's `/v1` segment — yielding 404s on every live model-list fetch.
    // See issue: "dynamic model-list fetch 404s" — public xai-oauth never
    // captured `grok-build-0.1` and Composer was masking the same defect via
    // its static fallback.
    const url = input.baseURL.replace(/\/+$/, "") + input.endpointPath;
    return withTimeout(input.timeoutMs, async (signal) => {
        const request = buildBearerRequest(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal,
        }, input.auth.access ?? "", { includeGrokClientHeaders: input.includeGrokClientHeaders });
        const initial = await fetch(request);
        if (initial.status !== 401) {
            return mapDynamicResponse(initial, input.kind);
        }
        // 401 → refresh once and retry.
        const refreshed = await refreshOAuthAuth(input.auth);
        const retry = buildBearerRequest(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal,
        }, refreshed.access, { includeGrokClientHeaders: input.includeGrokClientHeaders });
        const retryResponse = await fetch(retry);
        return mapDynamicResponse(retryResponse, input.kind);
    });
}
async function mapDynamicResponse(response, _kind) {
    if (!response.ok) {
        throw new Error(`Dynamic model list fetch failed with HTTP ${response.status}.`);
    }
    const text = await response.text();
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        throw new Error("Dynamic model list response was not valid JSON.");
    }
    const items = extractModelListItems(payload);
    return items
        .filter((item) => isChatModelItem(item))
        .map((item) => buildModelConfig(item));
}
function extractModelListItems(payload) {
    if (Array.isArray(payload)) {
        return payload.filter(isModelListItem);
    }
    if (payload && typeof payload === "object") {
        const obj = payload;
        for (const key of ["data", "models"]) {
            const value = obj[key];
            if (Array.isArray(value)) {
                return value.filter(isModelListItem);
            }
        }
    }
    return [];
}
function isModelListItem(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const id = value.id;
    return typeof id === "string" && id.length > 0;
}
/** Only keep chat/text endpoints. The media-denylist prefixes are excluded. */
function isChatModelItem(item) {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id.startsWith("grok-")) {
        return false;
    }
    for (const prefix of MEDIA_MODEL_DENYLIST_PREFIXES) {
        if (id.startsWith(prefix)) {
            return false;
        }
    }
    return true;
}
function buildModelConfig(item) {
    const rawId = typeof item.id === "string" ? item.id : "";
    const id = rawId.trim();
    const nameFromItem = typeof item.name === "string" ? item.name.trim() : "";
    const name = nameFromItem || prettifyModelId(id) || id;
    return {
        id,
        model: {
            name,
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: {
                context: pickNumericContext(item) ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
                output: pickNumericOutput(item) ?? DEFAULT_OUTPUT_TOKENS,
            },
        },
    };
}
function pickNumericContext(item) {
    for (const key of ["context_window", "contextWindow", "max_context_window"]) {
        const value = item[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return value;
        }
    }
    return undefined;
}
function pickNumericOutput(item) {
    for (const key of ["max_output_tokens", "output_token_limit"]) {
        const value = item[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return value;
        }
    }
    return undefined;
}
/** "grok-4.3" → "Grok 4.3"; "grok-build-0.1" → "Grok Build 0.1";
 *  "grok-composer-2.5-fast" → "Grok Composer 2.5 Fast". */
function prettifyModelId(id) {
    if (!id) {
        return "";
    }
    const tokens = id.split("-").filter(Boolean);
    if (tokens[0]?.toLowerCase() === "grok") {
        tokens.shift();
    }
    return tokens
        .map((token) => (/[0-9]/.test(token) ? token : titleCase(token)))
        .join(" ")
        .trim();
}
function titleCase(token) {
    if (!token) {
        return token;
    }
    return token.charAt(0).toUpperCase() + token.slice(1);
}
function unionAlwaysInclude(fetched, alwaysInclude) {
    if (alwaysInclude.length === 0) {
        return fetched;
    }
    const seen = new Set(fetched.map((m) => m.id));
    const out = [...fetched];
    for (const id of alwaysInclude) {
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        out.push({ id, model: { name: prettifyModelId(id) || id } });
    }
    return out;
}
// ---------------------------------------------------------------------------
// On-disk model cache
// ---------------------------------------------------------------------------
function modelCachePath() {
    return path.join(path.dirname(authStorePath()), XAI_MODELS_CACHE_FILE);
}
function readModelCache(providerId, baseURL, endpointPath) {
    try {
        const file = modelCachePath();
        if (!fs.existsSync(file)) {
            return undefined;
        }
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }
        if (parsed.version !== XAI_MODELS_CACHE_VERSION) {
            return undefined;
        }
        const providers = parsed.providers;
        if (!providers || typeof providers !== "object") {
            return undefined;
        }
        const entry = providers[providerId];
        if (!entry) {
            return undefined;
        }
        if (entry.baseURL !== baseURL) {
            return undefined;
        }
        if (entry.endpointPath !== endpointPath) {
            return undefined;
        }
        if (typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt)) {
            return undefined;
        }
        if (!Array.isArray(entry.models) || entry.models.length === 0) {
            return undefined;
        }
        if (!entry.models.every(isWellFormedDynamicModelConfig)) {
            return undefined;
        }
        return entry;
    }
    catch {
        return undefined;
    }
}
function isWellFormedDynamicModelConfig(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const entry = value;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
        return false;
    }
    return !!entry.model && typeof entry.model === "object";
}
function isModelCacheFresh(entry, ttlMs) {
    return Date.now() - entry.fetchedAt < ttlMs;
}
function writeModelCache(providerId, baseURL, endpointPath, models) {
    try {
        const file = modelCachePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let next = { version: XAI_MODELS_CACHE_VERSION, providers: {} };
        if (fs.existsSync(file)) {
            try {
                const existing = JSON.parse(fs.readFileSync(file, "utf8"));
                if (existing &&
                    typeof existing === "object" &&
                    existing.version === XAI_MODELS_CACHE_VERSION &&
                    existing.providers &&
                    typeof existing.providers === "object") {
                    next = existing;
                }
            }
            catch {
                // Corrupt file: start fresh.
            }
        }
        next.providers[providerId] = {
            baseURL,
            endpointPath,
            fetchedAt: Date.now(),
            models,
        };
        const tempFile = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(next, null, 2), "utf8");
        fs.renameSync(tempFile, file);
    }
    catch {
        // best-effort: never break startup
    }
}
// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------
function dedupe(values) {
    return Array.from(new Set(values));
}
async function withTimeout(timeoutMs, fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
        return await fn(controller.signal);
    }
    finally {
        clearTimeout(timer);
    }
}
function shouldOpenBrowser() {
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
function openBrowser(url) {
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
function browserCommand(url) {
    if (process.platform === "darwin") {
        return { file: "open", args: [url] };
    }
    if (process.platform === "win32") {
        return { file: "explorer.exe", args: [url] };
    }
    return { file: "xdg-open", args: [url] };
}
function withStreamIdleTimeout(response, timeoutMs = 45000) {
    if (!response.body)
        return response;
    const abortController = new AbortController();
    let timeoutId;
    const resetTimeout = () => {
        if (timeoutId)
            clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            abortController.abort(new Error(`Stream idle timeout of ${timeoutMs}ms exceeded`));
        }, timeoutMs);
    };
    const transform = new TransformStream({
        start() { resetTimeout(); },
        transform(chunk, controller) { resetTimeout(); controller.enqueue(chunk); },
        flush() { if (timeoutId)
            clearTimeout(timeoutId); }
    });
    // When the transform stream errors or closes, it will automatically
    // propagate back to the fetch response body if not consumed anymore,
    // but we can also manually hook it up if needed.
    return new Response(response.body.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}
//# sourceMappingURL=plugin.js.map