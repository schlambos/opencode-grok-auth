import type { Plugin } from "@opencode-ai/plugin";
import type { XaiGrokPluginOptions } from "./types.js";
export declare function createXaiGrokOAuthPlugin(providerId?: string, options?: XaiGrokPluginOptions): Plugin;
export declare const XaiGrokOAuthPlugin: Plugin;
export default XaiGrokOAuthPlugin;
/**
 * Dedicated provider for Composer 2.5, served by the Grok Build backend
 * (cli-chat-proxy.grok.com) rather than the public xAI API. Reuses an existing
 * Grok OAuth token (imported from the `xai-oauth`/`xai` auth entries) so no
 * second login is required, and injects `x-grok-model-override` for routing.
 */
export declare function createXaiComposerOAuthPlugin(providerId?: string): Plugin;
export declare const XaiComposerOAuthPlugin: Plugin;
export declare function applyDefaultProviderConfig(config: unknown, providerId?: string, opts?: {
    baseURL?: string;
    providerName?: string;
    models?: readonly string[];
}): void;
export declare function isSafeXaiApiUrl(url: URL): boolean;
