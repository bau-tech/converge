# Build Stage
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# No VITE_* build args here on purpose: this image is meant to be built once
# and published — see config.js.template/docker-entrypoint-config.sh below,
# which inject actual config from container env vars at *runtime* instead.
# `npm run dev`/`build` outside Docker still read these from .env via Vite
# as normal (src/runtimeConfig.js falls back to import.meta.env).
COPY . .
RUN npm run build

# Production Stage
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Generates /usr/share/nginx/html/config.js from this container's VITE_* env
# vars on every start (nginx's own /docker-entrypoint.d/ mechanism runs any
# script placed there before nginx boots).
COPY config.js.template /etc/nginx/config.js.template
COPY docker-entrypoint-config.sh /docker-entrypoint.d/40-inject-frontend-config.sh
RUN chmod +x /docker-entrypoint.d/40-inject-frontend-config.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
