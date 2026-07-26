FROM rust:latest AS builder
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y libssl-dev pkg-config
COPY persistent-vol/ ./persistent-vol/
WORKDIR /usr/src/app/persistent-vol
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --break-system-packages codepilot-ai==0.9.15
RUN pip install --no-cache-dir --break-system-packages dashscope
RUN pip install --no-cache-dir --break-system-packages voyageai

RUN curl -fsSL https://code-server.dev/install.sh | sh

RUN mkdir -p /opt/codepilot
COPY agent.yaml /opt/codepilot/agent.yaml
COPY agent_server.py /opt/codepilot/agent_server.py
COPY web_search_tool.py /opt/codepilot/web_search_tool.py
COPY entrypoint.sh /opt/codepilot/entrypoint.sh
RUN chmod +x /opt/codepilot/entrypoint.sh

RUN mkdir -p /root/.local/share/code-server/extensions/codepilot-extension
COPY extension/package.json /root/.local/share/code-server/extensions/codepilot-extension/
COPY extension/dist /root/.local/share/code-server/extensions/codepilot-extension/dist
COPY extension/media /root/.local/share/code-server/extensions/codepilot-extension/media

COPY --from=builder /usr/src/app/persistent-vol/target/release/snapshot-daemon /usr/local/bin/snapshot-daemon
RUN chmod +x /usr/local/bin/snapshot-daemon

WORKDIR /workspace

EXPOSE 8080

CMD ["/opt/codepilot/entrypoint.sh"]



