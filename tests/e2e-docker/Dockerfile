FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl bash sudo ca-certificates git procps psmisc \
    systemd systemd-sysv dbus \
    build-essential python3 \
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

RUN npm install -g @openai/codex @anthropic-ai/claude-code @qoder-ai/qodercli @qwen-code/qwen-code opencode-ai \
    && mkdir -p "$HOME/.local/bin" \
    && (command -v qodercli >/dev/null 2>&1 && ln -sf "$(command -v qodercli)" "$HOME/.local/bin/qoder" || true) \
    && mkdir -p "$HOME/.codex" "$HOME/.cursor" "$HOME/.qwen" "$HOME/.config/opencode"

# Cursor CLI installation with retry logic
RUN set +e; \
    for i in 1 2 3; do \
      echo "[dockerfile] Attempt $i: Installing Cursor CLI..."; \
      curl -fsSL --connect-timeout 30 --max-time 300 https://cursor.com/install | bash && break; \
      echo "[dockerfile] Cursor install failed, retrying in 5s..."; \
      sleep 5; \
    done; \
    if ! command -v agent >/dev/null 2>&1 && ! command -v cursor >/dev/null 2>&1; then \
      echo "[dockerfile] WARNING: Cursor CLI installation failed after 3 attempts (will retry in ensure phase)"; \
    fi

# Cursor official installer creates 'agent' binary; add 'cursor' symlink for compat
RUN if command -v agent >/dev/null 2>&1; then \
      mkdir -p "$HOME/.local/bin" && ln -sf "$(command -v agent)" "$HOME/.local/bin/cursor"; \
      echo "[dockerfile] Cursor CLI symlink created: cursor -> agent"; \
    elif command -v cursor >/dev/null 2>&1; then \
      echo "[dockerfile] Cursor CLI already installed"; \
    else \
      echo "[dockerfile] WARNING: No cursor/agent binary found after installation"; \
    fi

# Create default opencode.jsonc so pilot can inject plugin
RUN cat > "$HOME/.config/opencode/opencode.jsonc" <<'OPENCODE_JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": []
}
OPENCODE_JSON

# Create default qwen settings.json so pilot can inject hooks
RUN cat > "$HOME/.qwen/settings.json" <<'QWEN_JSON'
{
  "hooks": {}
}
QWEN_JSON

USER root
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

USER testuser
ENTRYPOINT ["/opt/entrypoint.sh"]
