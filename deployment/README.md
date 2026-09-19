# Home chat inside Home Assistant

**Open HA → Home chat.** It uses your existing HA login, permissions, and theme. The same panel works at your local or remote HA address; the browser needs no connection to the demo computer.

## Install on an HA Container server

This setup uses two containers with **host networking** on the same host: your existing HA container and a small Node.js bridge. It is not a Supervisor add-on. Back up HA’s configuration and secrets before editing them.

1. **Copy the integration.** Copy `custom_components/typesafe_chat` from this repo into HA’s `config/custom_components/` directory. Keep other integrations unchanged.
2. **Prepare the bridge.** On the HA server, create a `typesafe-chat` directory containing `compose.yaml`, `Dockerfile`, and `.dockerignore` from this folder, an empty `data/` directory, and an `app/` directory with the repo’s root `.mjs` files and `package.json`. Compose builds a small image with the pinned official Codex CLI; no host installation is needed. Do not copy `.env`, personal HA files, or device snapshots.
3. **Add secrets.** Copy `runtime.env.example` to `typesafe-chat/runtime.env`. Add your TypeSafe key and a random bridge token (`openssl rand -hex 32`). Run `chmod 600 runtime.env`. Put the **same bridge token** in HA’s `secrets.yaml`:

   ```yaml
   typesafe_chat_bridge_token: YOUR_RANDOM_BRIDGE_TOKEN
   ```

4. **Enable the panel.** Add this top-level section to HA’s `configuration.yaml`:

   ```yaml
   typesafe_chat:
     backend_url: http://127.0.0.1:5189
     bridge_token: !secret typesafe_chat_bridge_token
   ```

5. **Start and validate.** From `typesafe-chat/`, run `docker compose up -d --build`. Check HA’s configuration, restart HA, and refresh your browser. **Home chat** appears in the HA sidebar at `/home-chat`.

The bridge listens only on `127.0.0.1:5189`. Do not publish that port or add an iframe URL. The panel and its API travel through HA’s existing authenticated origin, including your existing HTTPS remote-access proxy. If your containers use another network arrangement, use a private shared container network and adapt the two internal URLs; do not expose the bridge to the internet.

## Connect ChatGPT once

Open **Home chat → chat history → gear (AI settings) → Connect ChatGPT** as an HA administrator. Open the sign-in link and enter the code; the panel updates when sign-in completes. If needed, enable device-code sign-in in ChatGPT’s security settings. This works from local and remote HA because it does not use a localhost browser callback.

- **One login for the home.** Every HA account uses this server-side subscription connection. Chats and HA device permissions remain per user. Only HA admins can connect, disconnect, or change the shared model.
- **Fast by default.** `Auto` prefers an available fast model (Spark, then Luna, then a mini/nano model) with its lightest supported reasoning. The picker uses Codex’s live model catalog. This is a speed-oriented preset, not a latency guarantee. Choose a specific model to pin it; an unavailable selection shows an error.
- **No OpenAI or Anthropic API key.** Replies, follow-ups, and compound-command splitting use your ChatGPT subscription allowance through [Codex App Server](https://learn.chatgpt.com/docs/app-server). If login expires or limits are reached, reconnect or wait; there is no automatic paid API fallback. The separate TypeSafe/Jev key is still required for device matching.

| Setting | Stored on the HA host |
| --- | --- |
| TypeSafe key and bridge secret | `typesafe-chat/runtime.env` (mode `600`) |
| ChatGPT login and refresh tokens | `typesafe-chat/data/chatgpt/auth.json`, inside a private directory |
| Shared model selection | `typesafe-chat/data/llm-settings.json` (mode `600`) |
| HA’s copy of the bridge secret | `config/secrets.yaml` |

Codex manages token refresh. Credentials survive container restarts and never go to HA users’ browsers, voice devices, or chat/tool history. Do not commit or publish `data/` or `runtime.env`; backups contain credentials too. The helper runs over private stdio with an isolated configuration, ephemeral requests, disabled execution environments/shell/apps, and restricted file access. Only text reaches the application; HA actions still pass through Jev and the existing review.

## Use the chat

- **Identity is automatic.** The server uses the authenticated HA account, not a name submitted by the browser. “My office” maps Fernando/Flavia to a uniquely named matching HA area. Other accounts can name a room explicitly.
- **Location is manual and per chat.** Choose the room or its bathroom beside the message box. If you ask “turn on the lights” without a location, the conversation asks you to choose one. Presence sensors do not identify who is there.
- **Review before applying.** Check the proposed devices, deselect any actions, then click **Apply selected** or reply **yes**. Keep typing to revise the request; revisions replace the old approval. **Cancel** makes no changes. Previews expire after two minutes and after a bridge restart.
- **History starts collapsed.** Open the chat-history icon to search titles/message previews, browse date groups, or start a new conversation. Each HA account has its own chats. Hover or focus a row to **Archive** it; the button is always visible on touch screens. Archiving another chat keeps your current conversation and draft in place. Use **Undo** to restore it immediately.
- **Archived chats stay readable.** Open **Archived**, select a conversation, then choose **Restore chat** to continue. Device controls and the composer stay disabled until restored. Archiving cancels pending approvals; restoring never replays actions. Chat options still let you rename or archive the current conversation.
- **Tool details start collapsed.** Expand a tool row to see the operations, request, and available timing. Choose **Request & response** under a tool, then expand **Request**, **Response**, **Usage**, or **Attempts** to inspect and copy JSON. Jev details include the questions, context, returned probabilities, model, timing, and request ID when supplied. Full payloads are loaded only when opened. Older messages keep their summaries and explain when full details were not recorded. These are saved API/tool data, not model reasoning. Results distinguish a sent command from an observed device state.

**Devices appear as interactive cards.** Ask “Which lights are on in my office?” or “What’s the temperature here?” to get light, climate, sensor, cover, media, and other device cards. Cards show a timestamped snapshot, not a live feed. Supported buttons, brightness/position sliders, and temperature/mode fields create a fresh review; they never apply immediately. Unavailable or read-only devices have no controls. Older text-only replies stay unchanged.

Bathrooms and closets remain app-only spaces inside the original HA area. Name or alias their devices with `bathroom`, `washroom`, `banheiro`, `lavabo`, `closet`, or `dressing room`. HA rooms and presence automations do not need to change.

The generative UI connects Jev-selected device results to a fixed component catalog (`chat-components.mjs` → `www/chat-components.js`). Messages save versioned `components` alongside their text fallback. Values come from HA; no model-generated HTML or JavaScript is executed. Card actions are bound to the owning chat and entity, rechecked against current capabilities and permissions, then use the same preview/approval flow as typed requests.

## Reuse the API for voice or other clients

The panel uses **API v1** at `POST /api/typesafe_chat`. It shares conversation logic with voice clients: explicit conversation/device IDs, per-chat location, speech responses, structured follow-up questions, and persisted request IDs. Shared voice devices do not imply a known speaker. [Contract, OpenAPI schema, client library, and runnable transcript example →](../docs/chat-api.md)

Actual microphones, STT/TTS, and an HA Assist adapter are future integrations; no audio hardware is configured by this setup.

## Data and access

HA filters inventory by the signed-in user’s read permissions. Device calls use that user’s current HA token and must pass control permissions plus the app’s service allowlist. The bridge has no administrator-token fallback. HA tokens are held only during each request; model keys and bridge credentials stay server-side.

TypeSafe receives request text, the account’s display name, selected location, and eligible device metadata/states. ChatGPT receives recent conversation context and proposed actions for follow-ups, plus requests for splitting or general answers. ChatGPT subscription limits and TypeSafe charges apply. The local demo still supports Anthropic when explicitly configured.

Chats are stored as private JSON files in `data/`, separated by hashed HA user ID. Sanitized tool payloads live separately in `data/tool-details/` and can only be retrieved through their owning account and conversation. Credentials are removed; state responses are permission/attribute filtered. Inspecting a saved payload never re-executes a request. Back up this directory if you want to keep history. Do not commit it or serve it as a static directory. The HA host administrator can access these files.

## Update or recover

Back up `data/`, the component, and the configuration first. Replace bridge source and restart it with `docker compose restart`; replace panel assets and refresh HA. After a Dockerfile or Compose change, use `docker compose up -d --build` to recreate the bridge. After changing `runtime.env`, use `docker compose up -d --force-recreate`; a plain restart does not reload container environment variables. Python integration changes require HA configuration validation and a restart. Expired previews must be requested again.

| Problem | Fix |
| --- | --- |
| Home chat missing | Check HA logs for `typesafe_chat`, validate YAML, restart HA, refresh the browser. |
| ChatGPT disconnected or limit reached | Open **AI settings**, reconnect if needed, or wait for the subscription limit to reset. Device-card previews remain available. |
| Chat unavailable | Check `docker compose ps` / `docker compose logs`; confirm both copies of the bridge token and private network URLs match. |
| Lost connection while applying | Reopen the chat to recover the saved result. Check actual device states before making a new request; actions are never automatically replayed. |
| Remote page fails | Verify ordinary HA works at that remote address first. Keep panel/API paths relative to that same origin. No laptop or port 5189 access is needed. |
| Incorrect office or bathroom | Check the account display name, unique area naming, and device names/aliases. Choose an explicit location to test. |

To roll back, remove the `typesafe_chat:` section, restore the backed-up configuration as needed, validate and restart HA, then run `docker compose down` in this bridge’s directory. Keep `data/` for recovery. No existing HA services, rooms, or automations need to be removed.
