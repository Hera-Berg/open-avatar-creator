# Multi-stage: build the SPA, then serve it as static files.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/renderer/package.json packages/renderer/
COPY packages/creator/package.json packages/creator/
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/packages/creator/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
