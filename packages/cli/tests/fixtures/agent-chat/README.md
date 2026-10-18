# Chat cassette fixtures (ticket 0847833f)

Record/replay e2e for the overlay agent chat.

## Files

- `synthetic-shape.jsonl` — HAND-WRITTEN wire-shape fixture (NOT a real
  recording). It exercises the replay machinery end to end: feed each line
  through a stub pi child, map via `mapPiRecord`, assert the exact overlay
  event sequence. Labeled synthetic so nobody mistakes it for model output.
- `<name>.jsonl` (real cassettes, git-ignored pattern `chat-real-*.jsonl`)
  — captured from a live `pi --mode rpc` run. The replay test picks up
  EVERY `chat-real-*.jsonl` file and replays it the same way.

## Recording a real cassette (needs a model + owner approval)

1. `REFRESH_CASSETTES=1` is not automated — recording is a manual,
   eyes-on step because it spends real model calls:
   - `pi --mode rpc` (same flags the chat server uses: cwd = a scratch
     project, `.pi/mcp.json` pointing at a local serve `/api/chat-mcp/*`)
   - paste each line you type into the prompt as
     `{"id":"rec-N","type":"prompt","message":"..."}`
   - save pi's raw stdout to `tests/fixtures/agent-chat/chat-real-<name>.jsonl`
2. Re-run the replay test: lines feed through the real `ChatSessionManager`
   framing + `mapPiRecord`, asserting the recorded overlay events. A pi
   protocol change turns the replay red — that is the point.
3. Scrub secrets from the cassette before committing (prompts may contain
   paths; never tokens — use a scratch project with no credentials).

## What replay proves (and does not prove)

Proves: framing, correlation, event mapping, and approval/tool-request
wiring stay byte-stable across pi versions. Does NOT prove: model
behavior, tool choices, or UI rendering (covered by unit + Playwright).
