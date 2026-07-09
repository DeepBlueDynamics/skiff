# skiff — sailing simulator + isochrone router
# Multi-stage: web (vite) + rust (axum/physics) → slim runtime.
# Cloud Run: listens on $PORT (falls back to 18081 locally).

# --- frontend build ---
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- backend build ---
FROM rust:slim AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin skiff

# --- runtime ---
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/target/release/skiff ./skiff
# Server serves static files from the relative path web/dist.
COPY --from=web /app/web/dist ./web/dist
ENV RUST_LOG=info
EXPOSE 8080
CMD ["./skiff"]
