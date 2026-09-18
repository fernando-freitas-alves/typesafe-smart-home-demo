# TypeSafe smart-home demo

<p align="center">
  <img width="1712" height="1818" alt="image" src="https://github.com/user-attachments/assets/d179c860-c4c0-4bb3-8492-06827f589452" />
</p>

A local recreation of the interface and execution patterns in [Allie Laabs’s TypeSafe Smart Home Demo](https://www.loom.com/share/18c4dbcf8db546dfb2d7f2ef018e78e4), with live TypeSafe evaluation and entirely mocked Home Assistant devices.

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

## Connect your real home

1. Add `HA_URL` and `HA_TOKEN` to your local `.env` (see [the example](.env.example)).
2. Open [Live Home](http://localhost:5188/live). Rooms and devices come from HA; states refresh every 10 seconds.
3. Ask a question or **Preview** a command. Review the named targets, then **Apply** to change real devices.

**Context:** select **I am** and **Where I am**. Both go to Jev with every request, even without current device states. “My office” / “meu escritório” uses the selected person's HA office; “here” / “aqui” uses their location. **Someone else** has no personal office. Choices stay in this browser; changing either clears the preview. These are preferences, not a login or automatic location tracking.

**Room scope:** “turn on the lights” defaults to your exact location. Bathrooms and closets are app-only spaces within the existing HA area, detected from device names. Jev receives both the parent `area` and the `space` (main/bathroom/closet); no new HA rooms are needed. Name another space to override your location, or say “all lights throughout the house”. Without a location, unnamed-room commands ask you to choose one. Presence sensors do not automatically identify a person or change the selection.

**Supported:** lights, fans, climate modes/temperatures, covers, media controls, and selected sensors. Hidden, disabled, and maintenance entities are filtered out. Unavailable devices cannot be controlled. Locks are read-only; switches require an explicit `HA_SWITCH_ENTITIES` allowlist. Standard HA service calls preserve existing HA automation and lighting-override behavior.

**Before applying:** previews expire after 2 minutes and are rejected if target states changed. Actions run once, stop on failure, and report observed states; physical commands are never automatically retried. A failed batch may have partially executed.

**Privacy:** HA credentials stay server-side; inventory is discovered at runtime, not stored in source. TypeSafe receives the request, room/device names, and selected identity/location; the checkbox adds current states. Claude also receives identity/location when splitting or answering. Manual controls make no model calls. The server binds to localhost.

## Try it

1. **Send a request:** choose one of the 13 examples or type your own.
2. **Watch the Decision Trace:** see confidence scores, unused questions, timings, raw answers, history, and replay.
3. **Click a device:** inspect its mock state or control it manually. States survive reloads; **Reset** restores defaults and offers **Undo**.

## How it works

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

- **Real:** TypeSafe evaluations and, with a key, [Anthropic responses](https://platform.claude.com/docs/en/api/messages/create).
- **Mocked:** all 10 devices in the 1BR layout. HA-shaped states and service calls cover lights, fans, speakers, switches, climate, and locks. **No real home connection or HA installation is needed.**
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
