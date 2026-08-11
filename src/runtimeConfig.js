// Single source of truth for config that varies per deployment. In the
// Docker image these values are injected at container startup into
// window.__CONFIG__ (see /config.js, generated from config.js.template by
// docker-entrypoint-config.sh) so one built image works for every
// deployment without a rebuild. Outside Docker (`npm run dev`/`build`),
// window.__CONFIG__ doesn't exist and every value falls back to Vite's
// build-time import.meta.env, unchanged from before.
const injected = typeof window !== 'undefined' ? window.__CONFIG__ : undefined

function pick(key, envKey, fallback = '') {
    const injectedValue = injected?.[key]
    if (injectedValue !== undefined && injectedValue !== null && injectedValue !== '') return injectedValue
    return import.meta.env[envKey] || fallback
}

export const RUNTIME_CONFIG = {
    NORMALIZER_URL: pick('NORMALIZER_URL', 'VITE_NORMALIZER_URL', 'http://localhost:8002'),
    SPECKLE_SERVER: pick('SPECKLE_SERVER', 'VITE_SPECKLE_SERVER', ''),
    SPECKLE_TOKEN: pick('SPECKLE_TOKEN', 'VITE_SPECKLE_TOKEN', ''),
    SHARE_LINK_MODE: pick('SHARE_LINK_MODE', 'VITE_SHARE_LINK_MODE', 'full'),
    EXTRA_SPECKLE_SERVERS: pick('EXTRA_SPECKLE_SERVERS', 'VITE_EXTRA_SPECKLE_SERVERS', ''),
    BCF_URL: pick('BCF_URL', 'VITE_BCF_URL', '/bcf'),
    BCF_API_KEY: pick('BCF_API_KEY', 'VITE_BCF_API_KEY', ''),
    OLLAMA_BASE_URL: pick('OLLAMA_BASE_URL', 'VITE_OLLAMA_BASE_URL', 'http://localhost:11434'),
    OLLAMA_MODEL: pick('OLLAMA_MODEL', 'VITE_OLLAMA_MODEL', 'llama3'),
    LMSTUDIO_BASE_URL: pick('LMSTUDIO_BASE_URL', 'VITE_LMSTUDIO_BASE_URL', 'http://localhost:1234/v1'),
    LMSTUDIO_MODEL: pick('LMSTUDIO_MODEL', 'VITE_LMSTUDIO_MODEL', 'local-model'),
    MISTRAL_API_KEY: pick('MISTRAL_API_KEY', 'VITE_MISTRAL_API_KEY', ''),
    ANTHROPIC_API_KEY: pick('ANTHROPIC_API_KEY', 'VITE_ANTHROPIC_API_KEY', ''),
}
