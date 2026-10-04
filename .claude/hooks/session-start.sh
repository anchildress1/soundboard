#!/bin/bash
# Claude Code cloud sessions only: Node from .nvmrc, the pinned pnpm, dependencies, and Playwright
# pointed at the container's preinstalled Chromium (the sandbox can't download browsers).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

export NVM_DIR=/opt/nvm
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
NODE_VERSION="$(cat .nvmrc)"
nvm install "$NODE_VERSION" > /dev/null
NODE_BIN="$(dirname "$(nvm which "$NODE_VERSION")")"
export PATH="$NODE_BIN:$PATH"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
pnpm install --frozen-lockfile

{
  echo "export PATH=\"$NODE_BIN:\$PATH\""
  echo 'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0'
  if [ -x /opt/pw-browsers/chromium ]; then
    echo 'export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium'
  fi
} >> "$CLAUDE_ENV_FILE"
