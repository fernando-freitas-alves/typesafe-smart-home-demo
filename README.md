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

## Behavior reproduced

- The command field, Send button, device-context selector, and all 13 visible example chips.
- The 1BR home with the same 10 devices, room grouping, starting states, mint active cards, and pink outlines for targeted devices.
- A 40%/60% split between the home and scrollable Decision Trace, compact typography, confidence badges, sorted option probabilities, and subdued unused questions.
- One live TypeSafe request containing the 12 questions visible in the recording. Code branches on intent, scope, room/device, device kind, and the relevant action. Speculative answers remain visible but cannot trigger unrelated services.
- Compound detection → LLM split → parallel TypeSafe evaluations → ordered mock actions.
- General questions route to the LLM; home status questions read the current simulated state without changing devices.
- Measured timing for each provider step, previous-request history, replay, reset, and raw-answer inspection.

The mock adapter uses HA-shaped entity IDs, states, attributes, and domain/service/service_data calls for `light`, `fan`, `media_player`, `switch`, `climate`, and `lock`. It has no HA URL, token, networking client, or real service integration. Clicking a device opens local controls and its mock HA state. Browser-local device state survives reloads; Reset restores the recording’s initial state and offers Undo.

## Boundaries of the recreation

The complete transcript was reviewed, with visual inspection across the opening and all three sections: single commands and speculative prompting (0:00–3:22), compound commands (3:22–4:45), and information routing (4:45–6:13). Reference frames inspected include 0:09, 0:33, 1:10, 2:00, 2:45, 3:25, 3:45, 4:15, 4:40, 5:10, 5:42, and 6:08.

This is an independent recreation based on the recording and [TypeSafe demo documentation](https://docs.typesafe.ai/demos/smart-home), not the original source or an official TypeSafe project. Unseen details cannot be guaranteed identical. Only the displayed 1BR layout is included. The device-context option adds the current mock states to the evaluation; the video does not demonstrate that selector’s options. Manual device controls, reset undo, mobile stacking, error recovery, and raw HA-call inspection are small local additions.

When no Anthropic key is configured:

- Compound examples use a **clearly labeled local string splitter**, then make real parallel TypeSafe calls. The splitter is limited and can reject more complicated phrasing.
- The World Series example uses the recording’s **clearly labeled sample answer**. Other general questions explain that a live LLM key is needed; no answer is fabricated.
- The trace says **Local fallback**, never Anthropic or LLM, for those steps.

With `ANTHROPIC_API_KEY`, those branches use the [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create), defaulting to `claude-haiku-4-5-20251001`. Live Claude validation passed for two- and three-command requests and a novel general question. The splitter accepts both plain JSON and JSON wrapped in a Markdown code block, while rejecting malformed command lists. TypeSafe uses the current `jev-latest` alias (resolved to `jev-1.13.0` during validation), so probabilities and latency will differ from the older recording. Timings are actual request durations, not copied demo values.

## Validation

```sh
npm test           # Deterministic tests, no external API calls
npm run test:live  # Opt-in: sends real requests using .env
```

Verification: 18 focused tests passed. All 13 video examples were evaluated through the live TypeSafe API and asserted against expected mock entity targets and routes. Additional live checks covered a changed device’s status, 20% dimming, unlocking, and a nonexistent garage. With Anthropic configured, live HTTP checks verified two- and three-command splitting, the expected parallel TypeSafe evaluations and mock service targets, and a novel general answer with no device mutations or local fallback. Browser checks exercised single and compound commands, state queries, the labeled information fallback, manual controls, history, context selection, reset/undo, and mobile scrolling. Stopping the local server produced an inline error without changing devices; restarting and clicking Retry completed the command and cleared the error.

The visual review follows the video’s light theme, cards, emoji icons, and exact example wording. Those explicit reference choices override generic landing-page styling rules. The applicable UI checks cover semantic controls, labels, focus indicators, loading/error/empty states, reduced motion, content wrapping, and responsive scrolling. Contrast checks led to slightly darker muted text than the recording so small trace text remains legible; the unused-question hierarchy is retained.

## Files

- `home.mjs`: canonical fixtures and mock HA adapter.
- `questions.mjs`: 12 prompts and response validation.
- `providers.mjs`: TypeSafe, optional Anthropic, and explicit fallback.
- `engine.mjs`: decision relevance, routing, and transactional mock updates.
- `server.mjs`: loopback-only API and allowlisted public files; keys stay server-side.
- `public/`: interface with no frontend dependencies.
- `tests/`: routing, mock state, failure, concurrency, and server-boundary tests.

API contract: [TypeSafe HTTP reference](https://docs.typesafe.ai/api). No Home Assistant installation is required.
