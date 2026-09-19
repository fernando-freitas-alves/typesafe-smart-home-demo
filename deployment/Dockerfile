FROM node:22-bookworm-slim
# Native HTTPS trust roots and the Linux sandbox required by Codex.
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates bubblewrap && rm -rf /var/lib/apt/lists/*
# Pin the official CLI used for managed ChatGPT login and private stdio RPC.
RUN npm install --global @openai/codex@0.155.1 && npm cache clean --force
WORKDIR /app
CMD ["node", "ha-chat-server.mjs"]
