# syntax=docker/dockerfile:1
FROM rust:1.83-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY widget ./widget
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/ai-visitor-widget /app/ai-visitor-widget
ENV DB_PATH=/data/visitors.db
ENV PORT=4009
VOLUME ["/data"]
EXPOSE 4009
CMD ["/app/ai-visitor-widget"]