FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CHROME_PATH=/usr/bin/google-chrome \
    BB1688_HOME=/app/runtime/1688

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg python3 python3-venv xvfb \
        fluxbox x11vnc novnc websockify \
        fonts-noto-cjk fonts-liberation \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY backend/requirements-runtime.txt backend/requirements-runtime.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r backend/requirements-runtime.txt \
    && python -m playwright install --with-deps chromium

COPY vendor/1688-cli/package.json vendor/1688-cli/package-lock.json vendor/1688-cli/
COPY vendor/1688-cli/scripts vendor/1688-cli/scripts
RUN cd vendor/1688-cli \
    && BB1688_SKIP_POSTINSTALL=1 npm ci --omit=dev \
    && npm cache clean --force

COPY . .
RUN mkdir -p /app/data /app/cookies /app/browser_profiles /app/runtime/1688 \
    && chmod +x /app/scripts/start_container.sh

EXPOSE 8000 6080

CMD ["/app/scripts/start_container.sh"]
