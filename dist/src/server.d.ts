export interface OAuthListener {
    redirectUri: string;
    waitForCallback(timeoutMs: number): Promise<URL>;
    close(): Promise<void>;
}
export declare function startXaiOAuthListener(preferredPort?: number): Promise<OAuthListener>;
