#!/bin/sh
# Runs automatically via nginx's /docker-entrypoint.d/ mechanism (any script
# there executes before nginx starts). Generates the runtime config.js the
# frontend reads at load time (see index.html, src/runtimeConfig.js) from
# whatever VITE_* values this container was started with — the same image
# works unmodified for every deployment, no rebuild/secrets-at-build-time
# needed (unlike nginx's own envsubst-on-templates.sh, which only targets
# /etc/nginx/conf.d, this writes into the served html root instead).
set -eu

envsubst '${VITE_NORMALIZER_URL} ${VITE_SPECKLE_SERVER} ${VITE_SPECKLE_TOKEN} ${VITE_SHARE_LINK_MODE} ${VITE_EXTRA_SPECKLE_SERVERS} ${VITE_BCF_URL} ${VITE_BCF_API_KEY} ${VITE_OLLAMA_BASE_URL} ${VITE_OLLAMA_MODEL} ${VITE_LMSTUDIO_BASE_URL} ${VITE_LMSTUDIO_MODEL} ${VITE_MISTRAL_API_KEY}' \
  < /etc/nginx/config.js.template \
  > /usr/share/nginx/html/config.js
