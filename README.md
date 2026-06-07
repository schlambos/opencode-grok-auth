# Grok OAuth Auth Plugin for OpenCode

OpenCode plugin that signs in to **xAI Grok** through the SuperGrok OAuth/PKCE
flow instead of using an `XAI_API_KEY`.

This is the xAI equivalent of the Antigravity OAuth plugin pattern: OpenCode
gets a provider, model definitions, an OAuth login method, automatic token
refresh, and a fetch layer that sends requests to `https://api.x.ai/v1`.

It also exposes **Cursor Composer 2.5** (`grok-composer-2.5-fast`) and the
agentic **`grok-build`** model through a second provider, `xai-composer`, which
talks to the Grok Build backend (`https://cli-chat-proxy.grok.com/v1`). See
[Composer 2.5 (Grok Build)](#composer-25-grok-build) below.

## What You Get

- OAuth login for `xai-oauth` inside `opencode auth login`.
- Local loopback callback on `http://127.0.0.1:56121/callback`, with random-port fallback if the port is busy.
- xAI OIDC discovery from `https://auth.x.ai/.well-known/openid-configuration`.
- Hermes-compatible authorize URL at `https://auth.x.ai/oauth2/authorize` with `referrer=hermes-agent`.
- Endpoint pinning so discovered OAuth URLs must be HTTPS on `x.ai` or `*.x.ai`.
- Hermes-compatible token exchange, including `code_verifier` plus the original `code_challenge`.
- Automatic refresh token handling through OpenCode's auth store.
- Provider and model definitions for current Grok OAuth models.
- A dedicated `xai-composer` provider for **Cursor Composer 2.5**, served by the Grok Build backend, that reuses your existing Grok token (no second login).
- Safety guard that refuses to send OAuth bearer tokens to anything except `https://api.x.ai` and `https://cli-chat-proxy.grok.com` (the Grok Build backend).

## Installation

This repo is currently installed locally. Once it is published to npm, the setup
can be simplified to the same `"plugin": ["opencode-grok-auth@latest"]`
style used by `opencode-antigravity-auth`.

Package name:

```text
opencode-grok-auth
```

Repository:

```text
https://github.com/ysnock404/opencode-grok-auth
```

### Current Local Install

Build the plugin:

```powershell
cd C:\Workspace\01_Coding\Active_Projects\Projetos\opencode-xai-grok-oauth
bun install
bun run build
```

The global OpenCode plugin wrapper has already been created here:

```text
C:\Users\ysnock\.config\opencode\plugins\xai-grok-oauth.js
```

It contains:

```js
export { default } from "file:///C:/Workspace/01_Coding/Active_Projects/Projetos/opencode-xai-grok-oauth/dist/index.js";
```

OpenCode loads global plugins from `~/.config/opencode/plugins/`, so this works
for any project where you run OpenCode.

### OpenCode Provider Config

The global config has also been updated:

```text
C:\Users\ysnock\.config\opencode\opencode.json
```

It now includes `provider.xai-oauth` with these model IDs:

- `grok-4.3`
- `grok-4.20-0309-reasoning`
- `grok-4.20-0309-non-reasoning`
- `grok-4.20-multi-agent-0309`

Equivalent config block:

```json
{
  "provider": {
    "xai-oauth": {
      "npm": "@ai-sdk/openai",
      "name": "xAI Grok OAuth",
      "options": {
        "baseURL": "https://api.x.ai/v1"
      },
      "models": {
        "grok-4.3": {
          "name": "Grok 4.3"
        },
        "grok-4.20-0309-reasoning": {
          "name": "Grok 4.20 Reasoning"
        },
        "grok-4.20-0309-non-reasoning": {
          "name": "Grok 4.20 Non-Reasoning"
        },
        "grok-4.20-multi-agent-0309": {
          "name": "Grok 4.20 Multi-Agent"
        }
      }
    }
  }
}
```

## Step-by-Step Instructions

1. Build the plugin:

```powershell
cd C:\Workspace\01_Coding\Active_Projects\Projetos\opencode-xai-grok-oauth
bun install
bun run build
```

2. Confirm the global wrapper exists:

```powershell
Get-Content $HOME\.config\opencode\plugins\xai-grok-oauth.js
```

3. Start OAuth login:

```powershell
opencode auth login
```

4. Pick:

```text
xAI Grok OAuth
```

5. Finish the xAI login in the browser.

6. Select a model in OpenCode:

```text
xai-oauth/grok-4.3
```

## Models

### Model Reference

| Model ID                       | Use                                       |
| ------------------------------ | ----------------------------------------- |
| `grok-4.3`                     | Default general-purpose Grok OAuth model. |
| `grok-4.20-0309-reasoning`     | Reasoning-heavy tasks.                    |
| `grok-4.20-0309-non-reasoning` | Faster non-reasoning variant.             |
| `grok-4.20-multi-agent-0309`   | Multi-agent oriented Grok variant.        |

The fallback list mirrors the Hermes Agent xAI OAuth model list as of this
implementation. If xAI renames or retires models, update `src/constants.ts` and
`~/.config/opencode/opencode.json`.

## Composer 2.5 (Grok Build)

**Cursor Composer 2.5** is not served by the public xAI API (`api.x.ai`). It
lives on the **Grok Build** backend — the same OpenAI-compatible endpoint the
`grok` CLI uses — at `https://cli-chat-proxy.grok.com/v1`. This plugin exposes
it through a dedicated provider, **`xai-composer`**.

### Models

| Model ID                 | Backend                       | Use                                              |
| ------------------------ | ----------------------------- | ------------------------------------------------ |
| `grok-composer-2.5-fast` | `cli-chat-proxy.grok.com`     | Cursor Composer 2.5 — agentic, multi-file coding. |
| `grok-build`             | `cli-chat-proxy.grok.com`     | xAI's agentic Grok Build model.                  |

> Note: `grok-build` (Grok Build backend) is a different model from
> `grok-build-0.1` (public `api.x.ai`).

### How it works

- **Backend routing:** the `xai-composer` provider points at
  `https://cli-chat-proxy.grok.com/v1`. The host guard allows this origin in
  addition to `api.x.ai`; the OAuth bearer is still refused everywhere else.
- **Cluster routing:** requests carry `x-grok-model-override: <model>` (plus
  `x-grok-client-version` / `x-grok-client-identifier`) so the proxy routes to
  the correct Composer inference cluster.
- **No second login:** on first use the provider imports your existing Grok
  OAuth token from the OpenCode auth store (`xai-oauth`, then `xai`), seeds it
  under `xai-composer`, and self-manages refresh. A standard
  `opencode auth login` ("OAuth with xAI Grok") works as a fallback.

### Config

The plugin auto-injects this provider at runtime, but the explicit block keeps
the model visible and lets you set limits:

```json
{
  "provider": {
    "xai-composer": {
      "npm": "@ai-sdk/openai",
      "name": "xAI Grok Composer (OAuth)",
      "options": {
        "baseURL": "https://cli-chat-proxy.grok.com/v1"
      },
      "models": {
        "grok-composer-2.5-fast": {
          "name": "Composer 2.5 Fast (Grok Build)"
        }
      }
    }
  }
}
```

Then select:

```text
xai-composer/grok-composer-2.5-fast
```

> Caveat: `cli-chat-proxy.grok.com` is the Grok CLI's private backend
> (undocumented, may change without notice) and usage counts against your Grok
> subscription tier.

## Configuration

### Plugin Loading

Current local install:

```text
~/.config/opencode/plugins/xai-grok-oauth.js
```

Future npm install:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-grok-auth@latest"]
}
```

Important: the OpenCode key is `plugin`, not `plugins`.

### Provider Behavior

The plugin auto-injects a default provider at runtime if `provider.xai-oauth`
is missing. The explicit config in `opencode.json` is still useful because it
makes the model list visible and matches the Antigravity setup style.

Disable auto-injection if you want to manage the provider block manually:

```powershell
$env:OPENCODE_XAI_OAUTH_AUTO_CONFIG = "false"
```

### Browser Behavior

By default, the plugin tries to open the xAI authorization URL in your browser.

Disable automatic browser launch:

```powershell
$env:OPENCODE_XAI_OAUTH_NO_BROWSER = "1"
opencode auth login
```

## Troubleshooting

### OAuth Callback Does Not Arrive

The plugin listens on:

```text
http://127.0.0.1:56121/callback
```

If the port is busy, it falls back to a random local port and uses that in the
OAuth `redirect_uri`.

If you are using SSH or a remote shell, forward the callback port:

```bash
ssh -L 56121:127.0.0.1:56121 user@host
```

### Model Not Found

Check that `provider.xai-oauth.models` exists in:

```text
C:\Users\ysnock\.config\opencode\opencode.json
```

Then restart OpenCode and select:

```text
xai-oauth/grok-4.3
```

### API Key Missing

This plugin does not use an API key. The loader returns an OAuth-backed fetch
handler and injects:

```http
Authorization: Bearer <xai access token>
```

If OpenCode still asks for an API key, the plugin did not load. Check:

```powershell
Get-Content $HOME\.config\opencode\plugins\xai-grok-oauth.js
Test-Path C:\Workspace\01_Coding\Active_Projects\Projetos\opencode-xai-grok-oauth\dist\index.js
```

## Documentation

- xAI Grok OAuth guide from Hermes Agent:
  https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth
- OpenCode plugins:
  https://opencode.ai/docs/plugins/
- OpenCode providers:
  https://opencode.ai/docs/providers/

## Security Notes

- Do not commit OpenCode auth files.
- Do not commit `.env`, shell transcripts, callback URLs, access tokens, or refresh tokens.
- The xAI OAuth client ID is public desktop OAuth metadata, not a secret.
- Discovered OAuth endpoints are pinned to HTTPS xAI origins.
- API bearer tokens are only sent to `api.x.ai` and `cli-chat-proxy.grok.com` (the Grok Build backend); all other hosts are blocked.
- On auth failure, re-run `opencode auth login`; do not manually paste tokens into config files.

## Credits

Implementation pattern inspired by:

- `opencode-antigravity-auth` by Noe Fabris
- Hermes Agent's xAI Grok OAuth implementation by Nous Research

## License

MIT
