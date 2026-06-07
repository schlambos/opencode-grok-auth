# Grok OAuth Auth Plugin for OpenCode

OpenCode plugin that signs in to **xAI Grok** through the SuperGrok OAuth/PKCE
flow instead of using an `XAI_API_KEY`.

One OAuth login. One Grok subscription. **All chat models** your account is
entitled to—including **Cursor Composer 2.5** (`grok-composer-2.5-fast`),
**Grok Build** (`grok-build` / `grok-build-0.1`), and current **Grok 4.x**
variants. The plugin discovers models automatically at startup (with a static
fallback if the network is down).

Routing to the correct xAI surface happens inside the plugin; you only pick a
model in OpenCode.

## What You Get

- OAuth login via `opencode auth login` → **OAuth with xAI Grok (SuperGrok)**.
- Local loopback callback on `http://127.0.0.1:56121/callback`, with random-port fallback if the port is busy.
- xAI OIDC discovery from `https://auth.x.ai/.well-known/openid-configuration`.
- Hermes-compatible authorize URL at `https://auth.x.ai/oauth2/authorize` with `referrer=hermes-agent`.
- Endpoint pinning so discovered OAuth URLs must be HTTPS on `x.ai` or `*.x.ai`.
- Hermes-compatible token exchange, including `code_verifier` plus the original `code_challenge`.
- Automatic refresh token handling through OpenCode's auth store.
- **Dynamic model list** from xAI (refreshed on a TTL cache; override with `OPENCODE_XAI_DYNAMIC_MODELS=false` for static lists only).
- **Shared token** across Grok models—log in once; Composer and Grok 4.x reuse the same credential (imported from `xai` / `xai-oauth` in the auth store when needed).
- Safety guard: OAuth bearer tokens are only sent to xAI-approved API hosts (`api.x.ai`, `cli-chat-proxy.grok.com`); everything else is blocked.

## Installation

Package name:

```text
opencode-grok-auth
```

Repository:

```text
https://github.com/schlambos/opencode-grok-auth
```

### Build (local)

```bash
cd /path/to/opencode-grok-auth
bun install
bun run build
```

OpenCode loads plugins from `~/.config/opencode/plugins/`. This setup uses two
small wrappers that export the same built plugin (different provider IDs
OpenCode needs internally):

```text
~/.config/opencode/plugins/xai-oauth.js
~/.config/opencode/plugins/xai-composer-oauth.js
```

Add both to `opencode.json` / `opencode.jsonc`:

```json
{
  "plugin": [
    "plugins/xai-oauth.js",
    "plugins/xai-composer-oauth.js"
  ]
}
```

Do **not** list `xai-oauth` under `disabled_providers` if you want the full
Grok catalog.

### OpenCode provider config (optional)

The plugin auto-injects provider blocks at runtime. Explicit config is optional
but useful for display names and limits:

```json
{
  "provider": {
    "xai-oauth": {
      "npm": "@ai-sdk/openai",
      "name": "xAI Grok OAuth",
      "options": {
        "baseURL": "https://api.x.ai/v1"
      }
    },
    "xai-composer": {
      "npm": "@ai-sdk/openai",
      "name": "xAI Grok Composer (OAuth)",
      "options": {
        "baseURL": "https://cli-chat-proxy.grok.com/v1"
      },
      "models": {
        "grok-composer-2.5-fast": {
          "name": "Composer 2.5 Fast"
        }
      }
    }
  }
}
```

## Quick start

1. Build the plugin (`bun install && bun run build`).
2. Install the plugin wrappers under `~/.config/opencode/plugins/` (see above).
3. `opencode auth login` → **OAuth with xAI Grok (SuperGrok)**.
4. Finish sign-in in the browser.
5. Restart OpenCode and pick any model below, for example:

```text
xai-oauth/grok-4.3
xai-oauth/grok-build-0.1
xai-composer/grok-composer-2.5-fast
xai-composer/grok-build
```

The `xai-oauth/` and `xai-composer/` prefixes are OpenCode provider IDs only.
They are not separate products—same plugin, same login.

## Models

Models are **discovered automatically** when OpenCode loads the plugin. If
discovery fails, a built-in static list is used until the next successful fetch.

Typical catalog (your account may differ):

| Model ID | Description |
| -------- | ----------- |
| `grok-4.3` | General-purpose Grok. |
| `grok-4.20-0309-reasoning` | Reasoning-heavy tasks. |
| `grok-4.20-0309-non-reasoning` | Faster non-reasoning variant. |
| `grok-4.20-multi-agent-0309` | Multi-agent oriented variant. |
| `grok-build-0.1` | Agentic coding (xAI API catalog). |
| `grok-composer-2.5-fast` | **Cursor Composer 2.5** — agentic, multi-file coding. |
| `grok-build` | Agentic Grok Build (CLI / harness catalog). |

`grok-build` and `grok-build-0.1` are **different model IDs** (same name
family, different endpoints behind the scenes). Pick the ID that appears in your
model picker.

Media / image / video models (`grok-imagine-*`, etc.) are excluded from chat
providers.

To force static lists only (no startup fetch):

```bash
export OPENCODE_XAI_DYNAMIC_MODELS=false
```

Static fallbacks live in `src/constants.ts` if you need to edit them.

## Configuration

### Plugin loading

Future npm install:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-grok-auth@latest"]
}
```

Important: the OpenCode key is `plugin`, not `plugins`.

### Provider behavior

Disable auto-injection of provider blocks:

```bash
export OPENCODE_XAI_OAUTH_AUTO_CONFIG=false
```

### Browser behavior

Disable automatic browser launch during OAuth:

```bash
export OPENCODE_XAI_OAUTH_NO_BROWSER=1
opencode auth login
```

## Troubleshooting

### OAuth callback does not arrive

Listener default:

```text
http://127.0.0.1:56121/callback
```

If the port is busy, the plugin picks a random local port. For SSH, forward the
callback port:

```bash
ssh -L 56121:127.0.0.1:56121 user@host
```

### Model not found

Ensure both plugin wrappers are in `plugin[]`, `xai-oauth` is not disabled, and
you have completed OAuth. Restart OpenCode. Check `provider.xai-oauth` and
`provider.xai-composer` in `opencode.jsonc` if you use explicit config.

### API key missing

This plugin does not use an API key. The loader injects:

```http
Authorization: Bearer <xai access token>
```

If OpenCode still asks for an API key, the plugin did not load—verify the
wrapper paths and that `dist/index.js` exists after `bun run build`.

## Documentation

- Hermes Agent xAI Grok OAuth guide:
  https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth
- OpenCode plugins: https://opencode.ai/docs/plugins/
- OpenCode providers: https://opencode.ai/docs/providers/

## Security notes

- Do not commit OpenCode auth files, tokens, or refresh tokens.
- The xAI OAuth client ID is public desktop OAuth metadata, not a secret.
- Discovered OAuth endpoints are pinned to HTTPS xAI origins.
- Bearer tokens are only sent to `api.x.ai` and `cli-chat-proxy.grok.com`.
- On auth failure, re-run `opencode auth login`; do not paste tokens into config.

## Credits

Implementation pattern inspired by:

- `opencode-antigravity-auth` by Noe Fabris
- Hermes Agent's xAI Grok OAuth implementation by Nous Research

## License

MIT