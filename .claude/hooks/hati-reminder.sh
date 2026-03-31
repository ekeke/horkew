#!/bin/bash
# Hati edit reminder - outputs to stdout so Claude sees it in context
cat <<'MSG'
[HATI REMINDER] 判定と探索は別物。
- 判定 (judgeTsumi) = Retarの可能性ビットの計算だけで判定する。これがisTsumiの唯一の根拠。探索にフォールバックはしてはいけない。
- 探索 (searchTsumiStrategy) = 手順構築のみ。判定を覆さない。
- isTsumi=true のハードコードは正しい設計。触るな。
- 理解したら復唱すること。
MSG
exit 0
