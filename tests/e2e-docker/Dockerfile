FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl bash sudo ca-certificates git procps psmisc \
    systemd systemd-sysv dbus \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash testuser \
    && echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER testuser
WORKDIR /home/testuser

ENV NPM_CONFIG_PREFIX="/home/testuser/.local"
ENV PATH="/home/testuser/.local/bin:$PATH"

# use mirror npm registry to accelerate speed
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set @loongsuite:registry https://registry.npmjs.org

RUN npm install -g @openai/codex @anthropic-ai/claude-code @qoder-ai/qodercli \
    && mkdir -p "$HOME/.local/bin" \
    && (command -v qodercli >/dev/null 2>&1 && ln -sf "$(command -v qodercli)" "$HOME/.local/bin/qoder" || true) \
    && mkdir -p "$HOME/.codex" "$HOME/.cursor"

RUN curl -fsSL --connect-timeout 30 --max-time 300 https://cursor.com/install | bash || \
    echo "[dockerfile] cursor official install failed (non-fatal, will retry in ensure phase)"

# Cursor official installer creates 'agent' binary; add 'cursor' symlink for compat
RUN if command -v agent >/dev/null 2>&1; then \
      mkdir -p "$HOME/.local/bin" && ln -sf "$(command -v agent)" "$HOME/.local/bin/cursor"; \
    fi

USER root
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

USER testuser
ENTRYPOINT ["/opt/entrypoint.sh"]
