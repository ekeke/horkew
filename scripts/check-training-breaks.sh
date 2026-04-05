#!/bin/bash
# 実行中の学習ジョブ以降のコミットで [break:*] タグを表示
# Usage: ./scripts/check-training-breaks.sh

STATUS_FILE="train-status.json"

if [ ! -f "$STATUS_FILE" ]; then
  echo "No training job found (${STATUS_FILE} not found)"
  exit 0
fi

SHA=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATUS_FILE','utf-8')).gitSha)")
echo "Training started at: ${SHA}"
echo ""

BREAKS=$(git log --oneline "${SHA}..HEAD" | grep '\[break:')

if [ -z "$BREAKS" ]; then
  echo "No breaking changes since ${SHA}. Safe to --resume."
else
  echo "Breaking changes since ${SHA}:"
  echo "$BREAKS"
  echo ""
  echo "Restart required."
fi
