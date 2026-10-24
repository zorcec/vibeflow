---
"@vibeflow-tools/cli": patch
---

The agent-chat opt-in is now `VIBEFLOW_FEATURES=CHAT` instead of the dedicated `VIBEFLOW_AGENT_CHAT=1`. One variable gates every opt-in surface; the value is a comma- and/or space-separated list matched case-insensitively, so future opt-ins reuse the same variable. With the flag absent, chat stays fully off.
