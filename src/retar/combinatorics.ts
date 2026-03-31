/*
組み合わせ生成器。０～M-1の整数からN個の数値の組み合わせを生成する。
パフォーマンスはベストではない。combination(6,3) で250ops/ms程度
ビット演算を使った実装などに代えれば5倍くらい早くなる。

  => 高速化バージョンを試したが、問題となるような大人数村ではこの部分はクリティカルではなかった
  => そのため、可読性を重視してこの実装のママにする
*/

// M個の整数からN個の数値の組み合わせを生成するジェネレーター
function* combGen(M: number, N: number, Base: number = 0): Generator<number[]> {
  if (N === 1) {
    for (let i = Base; i < M; i++) {
      yield [i]
    }
    return
  }
  for (let i = Base; i < M; i++) {
    for (let comb of combGen(M, N - 1, i + 1)) {
      yield [i, ...comb]
    }
  }
}

// 配列 arr から、indexesToSelect で指定されたインデックスの要素を選んで、その組み合わせと残りの要素を返す
function selectFromArray<T>(arr: T[], indexesToSelect: number[]) {
  const indexSet: Set<number> = new Set();
  // 指定されたインデックスをMapに追加
  for (const idx of indexesToSelect) {
    indexSet.add(idx)
  }

  const selected: T[] = []
  const remaining: T[] = []

  arr.forEach((item, index) => {
    if (indexSet.has(index)) {
      selected.push(item)
    } else {
      remaining.push(item)
    }
  })
  return [selected, remaining]
}

// 配列 arr から、N個、N-1個、...の要素を選んで、その組み合わせと残りの要素を返す
export function* selectCombinationsFromArray<T>(arr: T[], min: number, max: number) {
  for (let i = min; i <= Math.min(max, arr.length); i++) {
    for (let comb of combGen(arr.length, i)) {
      yield selectFromArray(arr, comb)
    }
  }
}

export function* generateCombinations<T>(arrays: T[][]): Generator<T[], void, undefined> {
  // 再帰的なヘルパー関数を定義
  function* combine(index: number, current: T[]): Generator<T[], void, undefined> {
      if (index === arrays.length) {
          yield current;
          return;
      }

      for (const item of arrays[index]) {
          yield* combine(index + 1, current.concat(item));
      }
  }

  // 初期インデックスと空の組み合わせリストから開始
  yield* combine(0, []);
}

