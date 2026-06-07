import type { PluginInput } from "@opencode-ai/plugin";
export interface OAuthAuthDetails {
    type: "oauth";
    refresh: string;
    access?: string;
    expires?: number;
}
export interface ApiKeyAuthDetails {
    type: "api_key";
    key: string;
}
export interface UnknownAuthDetails {
    type: string;
    [key: string]: unknown;
}
export type AuthDetails = OAuthAuthDetails | ApiKeyAuthDetails | UnknownAuthDetails;
export type GetAuth = () => Promise<AuthDetails>;
export type PluginClient = PluginInput["client"];
export interface ProviderModel {
    name?: string;
    cost?: {
        input: number;
        output: number;
        cache?: {
            read: number;
            write: number;
        };
    };
    limit?: {
        context: number;
        output: number;
    };
    [key: string]: unknown;
}
export interface Provider {
    models?: Record<string, ProviderModel>;
}
export interface LoaderResult {
    apiKey: string;
    baseURL?: string;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
export type DynamicModelListKind = "xai-language-models" | "openai-models";
export interface DynamicModelConfig {
    id: string;
    model: ProviderModel;
}
/** Loose shape for items returned by either the xAI or OpenAI-compatible
 *  model-list endpoints. We only care about a handful of fields. */
export type ModelListItem = Record<string, unknown> & {
    id?: unknown;
    name?: unknown;
    object?: unknown;
    owned_by?: unknown;
    created?: unknown;
    context_window?: unknown;
    contextWindow?: unknown;
    max_context_window?: unknown;
    max_output_tokens?: unknown;
    output_token_limit?: unknown;
};
export interface ModelCacheEntry {
    baseURL: string;
    endpointPath: string;
    fetchedAt: number;
    models: DynamicModelConfig[];
}
export interface ModelCacheFile {
    version: number;
    providers: Record<string, ModelCacheEntry>;
}
export interface XaiGrokPluginOptions {
    /** API base URL. Defaults to the public xAI API (`https://api.x.ai/v1`). */
    baseURL?: string;
    /** Human-readable provider name shown in OpenCode. */
    providerName?: string;
    /** Model IDs to inject into the provider config. */
    models?: readonly string[];
    /**
     * Inject the `x-grok-model-override` header (from the request body's `model`)
     * plus Grok client headers. Required to route to the Composer inference
     * cluster on the Grok Build proxy.
     */
    injectModelOverride?: boolean;
    /**
     * Auth-store provider keys to import an existing OAuth token from on first
     * use, so a dedicated provider can reuse an already-authenticated Grok token
     * without a second `opencode auth login`.
     */
    importTokenFrom?: readonly string[];
    /** Fetch and inject a dynamic model list on startup. Defaults to true. */
    dynamicModels?: boolean;
    /** Override the model-list endpoint path. */
    modelListPath?: string;
    /** Override the model-list response kind. */
    modelListKind?: DynamicModelListKind;
    /**
     * Model IDs that should always be present in the resolved defaults, even
     * when the dynamic fetch did not return them. Useful for static
     * fallbacks the plugin should never drop (e.g. Composer 2.5).
     */
    alwaysIncludeModels?: readonly string[];
    /** Cache TTL in ms for the dynamic model list. */
    modelCacheTtlMs?: number;
    /** Network timeout in ms for the dynamic model-list fetch. */
    modelFetchTimeoutMs?: number;
    /**
     * Auth-store keys to consult (in order) when resolving an OAuth token for
     * the dynamic model-list fetch, in addition to the provider's own key and
     * `importTokenFrom`.
     */
    modelAuthKeys?: readonly string[];
}
export type XaiTokenExchangeResult = {
    type: "success";
    provider: string;
    refresh: string;
    access: string;
    expires: number;
} | {
    type: "failed";
    error: string;
};
export interface XaiRefreshParts {
    refreshToken: string;
    tokenEndpoint?: string;
    redirectUri?: string;
}
export interface XaiDiscovery {
    authorizationEndpoint: string;
    tokenEndpoint: string;
}
export interface XaiTokenPayload {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    idToken?: string;
    tokenType: string;
}
