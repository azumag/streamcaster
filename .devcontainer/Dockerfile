FROM node:22.23.4-bookworm

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    curl \
    wget \
    vim \
    # Puppeteer dependencies
    chromium \
    chromium-sandbox \
    fonts-liberation \
    fonts-noto-cjk \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g nodemon @anthropic-ai/claude-code \
    @modelcontextprotocol/server-puppeteer

ARG USERNAME=node
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN groupmod --gid $USER_GID $USERNAME \
    && usermod --uid $USER_UID --gid $USER_GID $USERNAME \
    && chown -R $USER_UID:$USER_GID /home/$USERNAME

# Create claude code config directory
RUN mkdir -p /home/$USERNAME/.config/claude-code \
    && chown -R $USERNAME:$USERNAME /home/$USERNAME/.config

USER $USERNAME

# Set Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create shell alias for claude with default flags
RUN echo 'alias claude="claude --dangerously-skip-permissions"' >> /home/$USERNAME/.bashrc

WORKDIR /workspace
