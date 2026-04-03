#!/bin/bash
# 実行中の学習ジョブ以降のコミットで [break:*] タグを表示
# Usage: ./scripts/check-training-breaks.sh

SHA_FILE="train-orchestrate.sha"

if [ ! -f "$SHA_FILE" ]; then
  echo "No training job running (${SHA_FILE} not found)"
  exit 0
fi

SHA=$(cat "$SHA_FILE" | tr -d '[:space:]')
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
