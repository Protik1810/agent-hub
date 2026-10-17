#!/bin/sh
# Starts the Agent Hub on the local network (Linux / macOS). The admin token is in data/admin-token.txt.
cd "$(dirname "$0")"
export HUB_HOST="${HUB_HOST:-0.0.0.0}"
export HUB_PORT="${HUB_PORT:-7700}"
# The address agents on other machines use, e.g. http://192.168.1.10:7700 (shown in onboarding prompts)
export HUB_PUBLIC_URL="${HUB_PUBLIC_URL:-}"
exec node server.mjs
