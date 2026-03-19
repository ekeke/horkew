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

// 与えられた配列から一つの要素を返すジェネレータ
// 戻り値は [選択された要素、選択済みの要素の配列、未選択の要素の配列]のタプル
// 動的に組み合わせを生成するのに使う
// 元の並び順序は維持されないので注意
export function* selectOne<T>(arr: T[], additionalLeft: T[] = []): Generator<[T, T[], T[]], void, undefined> {
  if ( arr.length === 0 ) return
  const left: T[] = additionalLeft
  const right: T[] = [...arr]
  while (right.length) {
    const item: T = right.pop()!
    yield [item, left, right]
    left.push(item)
  }
  return
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

/**
 * バックトラックを使った組み合わせ生成器
 * @param matrix 要素の配列の配列
 */
export function* backtrackForMatrix<T, U>(matrix: T[][], context: U): Generator<{item: T, context: U, depth: number, index: number, last: boolean }, void, [boolean, U]> {
  let stack: { index: number, subIndex: number, context: U }[] = [{ index: 0, subIndex: 0, context: context }]
  if (matrix.length === 0) return
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    if (top.subIndex >= matrix[top.index].length) {
      stack.pop() // No more tests in this group, backtrack
      continue
    }
    const test = matrix[top.index][top.subIndex]
    const payload = {item: test, depth: top.index, index: top.subIndex, context: top.context, finished: false, last: top.index === matrix.length - 1}
    top.subIndex++ // Prepare next test in the current group
    const [result, newContext] = yield payload
    if (result) {
      if (top.index + 1 < matrix.length) {
        // Move to the next group
        stack.push({ index: top.index + 1, subIndex: 0, context: newContext })
      }
    }
  }
}
