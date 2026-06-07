import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  XAI_OAUTH_REDIRECT_HOST,
  XAI_OAUTH_REDIRECT_PATH,
  XAI_OAUTH_REDIRECT_PORT,
} from "./constants.js";

export interface OAuthListener {
  redirectUri: string;
  waitForCallback(timeoutMs: number): Promise<URL>;
  close(): Promise<void>;
}

const ALLOWED_CALLBACK_ORIGINS = new Set([
  "https://accounts.x.ai",
  "https://auth.x.ai",
]);

export async function startXaiOAuthListener(
  preferredPort = XAI_OAUTH_REDIRECT_PORT,
): Promise<OAuthListener> {
  let resolveCallback: ((url: URL) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;

  const callbackPromise = new Promise<URL>((resolve, reject) => {
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
    waitForCallback(timeoutMs: number) {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for the xAI OAuth callback.")), timeoutMs);
      });
      return Promise.race([callbackPromise, timeout]);
    },
    close() {
      return new Promise<void>((resolve) => {
        rejectCallback = undefined;
        server.close(() => resolve());
      });
    },
  };
}

function listenWithFallback(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean) => {
      const onError = (error: NodeJS.ErrnoException) => {
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

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onCallback: (url: URL) => void,
): void {
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
  res.end(
    `<html><body><h1>${failed ? "xAI authorization failed." : "xAI authorization received."}</h1>You can close this tab.</body></html>`,
  );
}
