# TypeSafe smart-home demo

<p align="center">
  <img width="1712" height="1818" alt="image" src="https://github.com/user-attachments/assets/d179c860-c4c0-4bb3-8492-06827f589452" />
</p>

A local recreation of the interface and execution patterns in [Allie Laabs’s TypeSafe Smart Home Demo](https://www.loom.com/share/18c4dbcf8db546dfb2d7f2ef018e78e4), with live TypeSafe evaluation, a mocked demo, a diagnostic page for real devices, and a native Home Assistant chat panel.

https://github.com/user-attachments/assets/c88350a5-4b4b-4f89-916d-cd8ff27e7eca

## Run

Requires Node.js 22 or newer. There are no dependencies to install.

Clone the repository, create a local configuration file, and add your own keys:

```sh
git clone https://github.com/fernando-freitas-alves/typesafe-smart-home-demo.git
cd typesafe-smart-home-demo
cp .env.example .env
# Edit .env and add TYPESAFE_API_KEY and, optionally, ANTHROPIC_API_KEY.
npm start
```

Open [localhost:5188](http://localhost:5188). No build step is needed. To choose another port, run `DEMO_PORT=5189 npm start`. Stop the foreground server with Ctrl+C.

The server reads `TYPESAFE_API_KEY` from the root `.env`. It rereads configuration for each request, so adding `ANTHROPIC_API_KEY` activates Claude Haiku without restarting. The optional variables and model defaults are in [`.env.example`](.env.example). Existing environment variables take precedence over the file. Keep `.env` local; it is excluded from Git. Requests send command text, and optionally the simulated device states, to TypeSafe. With an Anthropic key, splitting and general answers also send the command text to Anthropic. These APIs may incur usage charges. Keys remain on the local server and are never sent to the browser.

## Chat inside Home Assistant

**HA → Home chat** provides a ChatGPT-style conversation using HA’s login and theme. It works through the same local or remote HA address, with no laptop server needed.

- Shared ChatGPT subscription login and model picker in **chat history → AI settings**; fast model preset by default. No OpenAI/Anthropic API key for this panel; Jev still needs its TypeSafe key.
- Automatic HA identity; manual room/bathroom selection in each chat.
- Saved, account-specific threads in a collapsed sidebar with search, previews, date groups, and an Archived view.
- Collapsed tool activity, action-selection forms, and follow-up messages.
- Generative device cards with state readings, supported controls, and timestamped snapshots.
- Review changes, then click **Apply selected** or reply **yes**. Typing a revision replaces the pending approval.

[Install, run, update, and recover the native panel →](deployment/README.md)

**Reusable API:** the page uses the same versioned conversation API available to future room voice devices. It returns speech, structured confirmations/location questions, components, and tool details. [API contract, client, and voice-adapter example →](docs/chat-api.md)

## Connect your real home (local diagnostic page)

Complete **Run** above first. The computer running the demo must be able to reach your HA instance.

1. In HA, open your profile and create a **Long-Lived Access Token** ([official instructions](https://developers.home-assistant.io/docs/api/rest/)).
2. Add these values to the root `.env`. Use your HA base URL, without `/api` or a dashboard path:

   ```dotenv
   HA_URL=http://homeassistant.local:8123
   HA_TOKEN=your-long-lived-access-token
   ```

3. Keep `npm start` running and open [Live Home](http://localhost:5188/live). Configuration changes need no restart; use **Refresh** to reconnect. States refresh every 10 seconds while the page is active.
4. Set **I am** and **Where I am**, then **Preview** a request. Only **Apply** changes real devices.

`TYPESAFE_API_KEY` is required for natural-language requests; `ANTHROPIC_API_KEY` enables general answers and full compound-command splitting. Without model keys, device-card controls still produce previews. See [`.env.example`](.env.example) for all settings.

### Test the office bathroom

1. Choose **I am → Fernando** and **Where I am → Fernando’s office · bathroom**. Leave **Room scope → All rooms** so the filter does not exclude your location.
2. Enter **“turn on the lights”** and click **Preview**. Check that **Target** and every listed device belong to the bathroom.
3. Change **Where I am → Fernando’s office**, then preview the same request. Only the main office lights should appear. Testing previews does not change device states.

**Context:** Jev always receives your identity and location; **Include current states** adds device states. “My office” / “meu escritório” uses your identity. “The lights” / “here” / “aqui” uses your exact location. An explicitly named space overrides location; “all lights throughout the house” targets the home. **Room scope** limits eligible devices independently. Choices stay in this browser; changing either clears the preview. **Someone else** has no personal office. These are preferences, not a login.

**Spaces:** bathrooms and closets remain inside the existing HA area. Device names or aliases containing `bathroom`, `washroom`, `banheiro`, `lavabo`, `closet`, or `dressing room` create app-only location choices. Jev receives the parent `area` and `space` (main/bathroom/closet); HA configuration is unchanged. Personal office matching needs one area named like `Fernando’s office`, `Flavia’s office`, or the Portuguese equivalent. Presence sensors do not yet change the location selection or identify a person.

### If something is missing

| Symptom | Check |
| --- | --- |
| Cannot connect / token rejected | Confirm `HA_URL` is reachable from this computer and `HA_TOKEN` is complete and has permission to read HA registries. |
| No bathroom choice | Its device names or aliases must identify the bathroom, and the entities must belong to the parent HA area. Registry changes can take up to 60 seconds; refresh afterward. |
| Old selectors or layout | Reload the browser page after a code update. **Refresh** reloads device data only. |
| No matching device / location conflict | Select the exact space, set **Room scope** to **All rooms**, or name the target explicitly. |

**Supported:** lights, fans, climate modes/temperatures, covers, media controls, and selected sensors. Hidden, disabled, and maintenance entities are filtered out. Unavailable devices cannot be controlled. Locks are read-only; switches require an explicit `HA_SWITCH_ENTITIES` allowlist. Standard HA service calls preserve existing HA automation and lighting-override behavior.

**Before applying:** previews expire after 2 minutes and are rejected if target states changed. Actions run once, stop on failure, and report observed states; physical commands are never automatically retried. A failed batch may have partially executed.

**Privacy:** HA credentials stay server-side; inventory is discovered at runtime, not stored in source. TypeSafe receives the request, room/device names, and selected identity/location; the checkbox adds current states. Claude also receives identity/location when splitting or answering. Manual controls make no model calls. The server binds to localhost.

## Try the mock demo

1. **Send a request:** choose one of the 13 examples or type your own.
2. **Watch the Decision Trace:** see confidence scores, unused questions, timings, raw answers, history, and replay.
3. **Click a device:** inspect its mock state or control it manually. States survive reloads; **Reset** restores defaults and offers **Undo**.

## How the mock demo works

TypeSafe evaluates **12 questions in one request**. Only relevant answers can trigger actions.

| Request | What happens |
| --- | --- |
| Single command | TypeSafe selects the target and mock HA service. |
| Multiple commands | Claude splits → TypeSafe evaluates in parallel → mock actions run in order. |
| Home status | Reads the current simulated state; changes nothing. |
| General question | Claude answers; changes no devices. |

**Default models:** TypeSafe `jev-latest`; Claude `claude-haiku-4-5-20251001`. Probabilities and latency can differ from the recording; timings are measured live.

### Without an Anthropic key

The trace explicitly shows **Local fallback**:

- **Compound commands:** a limited local splitter; TypeSafe calls remain live. Complex phrasing may be rejected.
- **General questions:** the 1989 World Series example has a labeled sample answer. Other questions require `ANTHROPIC_API_KEY`.

## What’s real, what’s mocked

- **Real:** TypeSafe evaluations and, with a key, [Anthropic responses](https://platform.claude.com/docs/en/api/messages/create). The separate `/live` page reads your HA inventory and sends real service calls only after **Apply**.
- **Mocked:** all 10 devices in the 1BR layout at `/`. HA-shaped states and service calls cover lights, fans, speakers, switches, climate, and locks. **The mock demo needs no HA installation.**
- **Recreated:** the video’s layout, colors, icons, examples, and trace. Manual controls, device context, reset/undo, mobile layout, and error recovery are local additions. Device context includes current mock states in evaluation.

Independent, unofficial recreation based on the full recording and [TypeSafe demo docs](https://docs.typesafe.ai/demos/smart-home). Only the shown 1BR layout is included; unseen behavior may differ.

## Check it

```sh
npm test           # Deterministic tests; no API calls
npm run test:live  # All 13 examples; real API calls using .env (may incur charges)
```

**Mock demo verified:** all 13 examples with live TypeSafe; Claude splitting and general answers; state queries, dimming, unlocking, and missing-device handling. Browser checks covered controls, history, context, reset/undo, mobile scrolling, accessibility, and failure/retry without device changes on failure.

**Live mode validation:** state queries and command previews were checked against HA. Tests simulate physical writes, including stale previews, partial failures, and replay protection; they do not actuate your home.

## Find the code

| File | Purpose |
| --- | --- |
| [home.mjs](home.mjs) | Mock devices and HA adapter |
| [questions.mjs](questions.mjs) · [engine.mjs](engine.mjs) | Questions, routing, and mock actions |
| [providers.mjs](providers.mjs) · [ha-client.mjs](ha-client.mjs) | TypeSafe, Claude, and HA connections |
| [server.mjs](server.mjs) · [live-engine.mjs](live-engine.mjs) | Localhost API and live command previews |
| [public/](public/) · [tests/](tests/) | Dependency-free UI and tests |

API details: [TypeSafe HTTP reference](https://docs.typesafe.ai/api).
