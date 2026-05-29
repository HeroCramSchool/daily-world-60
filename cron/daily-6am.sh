#!/usr/bin/env bash
# Daily World 60 — 毎朝6:00 NZST 実行スクリプト
# crontab -e で以下を追加:
#   0 18 * * * /Users/hiro/.company/affiliate/automation/shorts-pipeline/cron/daily-6am.sh

set -euo pipefail

cd "$(dirname "$0")/.."

LOG_DIR="output/_logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

{
  echo "==== $(date -u) start ===="
  npm run pipeline
  echo "==== $(date -u) end ===="
} >> "$LOG_FILE" 2>&1
