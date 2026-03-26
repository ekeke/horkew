# Fenrir パフォーマンス記録

## ベンチマーク環境

- シナリオ: 14d-neko (14人村、初日犠牲者あり、完全再投票→引き分け)
- 構成: 狼3/村2/占1/霊1/狩1/共2/猫1/信1/狐1/背1
- GPU: NVIDIA GeForce GTX 1660 SUPER (4GB)
- Node.js v22.13.1, TensorFlow.js GPU

## ベンチマーク結果 (2026-03-26)

5ゲーム計測、1ゲームあたりの平均。

### ゲーム生成

| 構成 | ms/game |
|---|---|
| Heuristic only (no Retar) | 129.5 |
| Heuristic + Retar | 69.7 |
| ML + Retar (full) | 835.5 |
| ML only (no Retar) | 979.1 |

- Retar有効時にHeuristicが速くなるのは、Retarの推論結果がヒューリスティックの意思決定を高速化するため
- ML agentはNN forward passがボトルネック (下記参照)

### 個別コンポーネント (1000回計測)

| コンポーネント | ms/call |
|---|---|
| NN forward (Pure JS) | 2.58 |
| NN forward (TF.js GPU) | 10.54 |
| encodeObservation | 0.03 |

### 備考

- Pure JS の NN forward が TF.js GPU より高速 (2.58 vs 10.54 ms/call)
  - 原因: 単一サンプル推論ではGPU転送オーバーヘッドが支配的
  - TF.js GPU はバッチ学習 (PPO backward) で真価を発揮
- ゲーム内推論は Pure JS、学習ループは TF.js GPU の二刀流が最適
- encodeObservation (0.03ms) はボトルネックではない
