import http, {} from "node:http";
import { XAI_OAUTH_REDIRECT_HOST, XAI_OAUTH_REDIRECT_PATH, XAI_OAUTH_REDIRECT_PORT, } from "./constants.js";
const ALLOWED_CALLBACK_ORIGINS = new Set([
    "https://accounts.x.ai",
    "https://auth.x.ai",
]);
export async function startXaiOAuthListener(preferredPort = XAI_OAUTH_REDIRECT_PORT) {
    let resolveCallback;
    let rejectCallback;
    const callbackPromise = new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });
    const server = http.createServer((req, res) => {
        handleRequest(req, res, (url) => {
            resolveCallback?.(url);
        });
    });
    const port = await listenWithFallback(server, preferredPort);
    const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${port}${XAI_OAUTH_REDIRECT_PATH}`;
    return {
        redirectUri,
        waitForCallback(timeoutMs) {
            const timeout = new Promise((_, reject) => {
                setTimeout(() => reject(new Error("Timed out waiting for the xAI OAuth callback.")), timeoutMs);
            });
            return Promise.race([callbackPromise, timeout]);
        },
        close() {
            return new Promise((resolve) => {
                rejectCallback = undefined;
                server.close(() => resolve());
            });
        },
    };
}
function listenWithFallback(server, preferredPort) {
    return new Promise((resolve, reject) => {
        const tryListen = (port, allowFallback) => {
            const onError = (error) => {
                server.off("listening", onListening);
                if (allowFallback && error.code === "EADDRINUSE") {
                    tryListen(0, false);
                    return;
                }
                reject(error);
            };
            const onListening = () => {
                server.off("error", onError);
                const address = server.address();
                if (!address || typeof address === "string") {
                    reject(new Error("Could not determine xAI OAuth callback port."));
                    return;
                }
                resolve(address.port);
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, XAI_OAUTH_REDIRECT_HOST);
        };
        tryListen(preferredPort, preferredPort !== 0);
    });
}
function handleRequest(req, res, onCallback) {
    const origin = req.headers.origin;
    const allowOrigin = typeof origin === "string" && ALLOWED_CALLBACK_ORIGINS.has(origin) ? origin : "";
    if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }
    const host = req.headers.host ?? `${XAI_OAUTH_REDIRECT_HOST}:${XAI_OAUTH_REDIRECT_PORT}`;
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method !== "GET" || url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found.");
        return;
    }
    onCallback(url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const failed = url.searchParams.has("error");
    res.end(`<html><body><h1>${failed ? "xAI authorization failed." : "xAI authorization received."}</h1>You can close this tab.</body></html>`);
}
//# sourceMappingURL=server.js.map