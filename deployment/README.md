# Home chat inside Home Assistant

**Open HA → Home chat.** It uses your existing HA login, permissions, and theme. The same panel works at your local or remote HA address; the browser needs no connection to the demo computer.

## Install on an HA Container server

This setup uses two containers with **host networking** on the same host: your existing HA container and a small Node.js bridge. It is not a Supervisor add-on. Back up HA’s configuration and secrets before editing them.

1. **Copy the integration.** Copy `custom_components/typesafe_chat` from this repo into HA’s `config/custom_components/` directory. Keep other integrations unchanged.
2. **Prepare the bridge.** On the HA server, create a `typesafe-chat` directory containing `compose.yaml` from this folder, an empty `data/` directory, and an `app/` directory with the repo’s root `.mjs` files and `package.json`. No install or build step is needed. Do not copy `.env`, personal HA files, or device snapshots.
3. **Add secrets.** Copy `runtime.env.example` to `typesafe-chat/runtime.env`. Add your TypeSafe and Anthropic keys and a random bridge token (`openssl rand -hex 32`). Run `chmod 600 runtime.env`. Put the **same bridge token** in HA’s `secrets.yaml`:

   ```yaml
   typesafe_chat_bridge_token: YOUR_RANDOM_BRIDGE_TOKEN
   ```

4. **Enable the panel.** Add this top-level section to HA’s `configuration.yaml`:

   ```yaml
   typesafe_chat:
     backend_url: http://127.0.0.1:5189
     bridge_token: !secret typesafe_chat_bridge_token
   ```

5. **Start and validate.** From `typesafe-chat/`, run `docker compose up -d`. Check HA’s configuration, restart HA, and refresh your browser. **Home chat** appears in the HA sidebar at `/home-chat`.

The bridge listens only on `127.0.0.1:5189`. Do not publish that port or add an iframe URL. The panel and its API travel through HA’s existing authenticated origin, including your existing HTTPS remote-access proxy. If your containers use another network arrangement, use a private shared container network and adapt the two internal URLs; do not expose the bridge to the internet.

## Use the chat

- **Identity is automatic.** The server uses the authenticated HA account, not a name submitted by the browser. “My office” maps Fernando/Flavia to a uniquely named matching HA area. Other accounts can name a room explicitly.
- **Location is manual and per chat.** Choose the room or its bathroom beside the message box. If you ask “turn on the lights” without a location, the conversation asks you to choose one. Presence sensors do not identify who is there.
- **Review before applying.** Check the proposed devices, deselect any actions, then click **Apply selected** or reply **yes**. Keep typing to revise the request; revisions replace the old approval. **Cancel** makes no changes. Previews expire after two minutes and after a bridge restart.
- **History starts collapsed.** Open the chat-history icon to switch conversations or start a new one. Each HA account has its own saved chats. Chat options let you rename or archive a conversation; archived history stays in server storage.
- **Tool details start collapsed.** Expand a tool row to see the operations, request, and available timing. These are actual tool summaries; they are not model reasoning. Results distinguish a sent command from an observed device state.

Bathrooms and closets remain app-only spaces inside the original HA area. Name or alias their devices with `bathroom`, `washroom`, `banheiro`, `lavabo`, `closet`, or `dressing room`. HA rooms and presence automations do not need to change.

## Data and access

HA filters inventory by the signed-in user’s read permissions. Device calls use that user’s current HA token and must pass control permissions plus the app’s service allowlist. The bridge has no administrator-token fallback. HA tokens are held only during each request; model keys and bridge credentials stay server-side.

TypeSafe receives request text, the account’s display name, selected location, and eligible device metadata/states. Anthropic receives recent conversation context and proposed actions for follow-ups, plus requests for splitting or general answers. Provider charges may apply.

Chats are stored as private JSON files in `data/`, separated by hashed HA user ID. Back up this directory if you want to keep history. Do not commit it or serve it as a static directory. The HA host administrator can access these files.

## Update or recover

Back up `data/`, the component, and the configuration first. Replace bridge source and restart it with `docker compose restart`; replace panel assets and refresh HA. Python integration changes require HA configuration validation and a restart. Expired previews must be requested again.

| Problem | Fix |
| --- | --- |
| Home chat missing | Check HA logs for `typesafe_chat`, validate YAML, restart HA, refresh the browser. |
| Chat unavailable | Check `docker compose ps` / `docker compose logs`; confirm both copies of the bridge token and private network URLs match. |
| Lost connection while applying | Reopen the chat to recover the saved result. Check actual device states before making a new request; actions are never automatically replayed. |
| Remote page fails | Verify ordinary HA works at that remote address first. Keep panel/API paths relative to that same origin. No laptop or port 5189 access is needed. |
| Incorrect office or bathroom | Check the account display name, unique area naming, and device names/aliases. Choose an explicit location to test. |

To roll back, remove the `typesafe_chat:` section, restore the backed-up configuration as needed, validate and restart HA, then run `docker compose down` in this bridge’s directory. Keep `data/` for recovery. No existing HA services, rooms, or automations need to be removed.
