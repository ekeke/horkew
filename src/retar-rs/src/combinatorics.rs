/// Generate C(M,N) index combinations starting from `base`, calls `callback` with each.
fn comb_gen(m: usize, n: usize, base: usize, current: &mut Vec<usize>, callback: &mut impl FnMut(&[usize])) {
    if n == 1 {
        for i in base..m {
            current.push(i);
            callback(current);
            current.pop();
        }
        return;
    }
    for i in base..m {
        current.push(i);
        comb_gen(m, n - 1, i + 1, current, callback);
        current.pop();
    }
}

/// Select `min..=max` items from `arr`, yielding (selected, remaining) for each combination.
pub fn select_combinations_from_array<T: Clone>(
    arr: &[T],
    min: usize,
    max: usize,
    callback: &mut impl FnMut(&[T], &[T]),
) {
    let effective_max = max.min(arr.len());
    for size in min..=effective_max {
        if size == 0 {
            continue;
        }
        let mut indices = Vec::with_capacity(size);
        comb_gen(arr.len(), size, 0, &mut indices, &mut |idx_combo| {
            let mut selected = Vec::with_capacity(idx_combo.len());
            let mut remaining = Vec::with_capacity(arr.len() - idx_combo.len());
            let idx_set: std::collections::HashSet<usize> = idx_combo.iter().copied().collect();
            for (i, item) in arr.iter().enumerate() {
                if idx_set.contains(&i) {
                    selected.push(item.clone());
                } else {
                    remaining.push(item.clone());
                }
            }
            callback(&selected, &remaining);
        });
    }
}

/// Cartesian product of arrays. Calls `callback` with each combination.
pub fn generate_combinations<T: Clone>(
    arrays: &[Vec<T>],
    callback: &mut impl FnMut(&[T]),
) {
    let mut current = Vec::new();
    generate_combinations_inner(arrays, 0, &mut current, callback);
}

fn generate_combinations_inner<T: Clone>(
    arrays: &[Vec<T>],
    index: usize,
    current: &mut Vec<T>,
    callback: &mut impl FnMut(&[T]),
) {
    if index == arrays.len() {
        callback(current);
        return;
    }
    for item in &arrays[index] {
        current.push(item.clone());
        generate_combinations_inner(arrays, index + 1, current, callback);
        current.pop();
    }
}

/// Cartesian product that collects all results into a Vec.
pub fn generate_combinations_collect<T: Clone>(arrays: &[Vec<T>]) -> Vec<Vec<T>> {
    let mut results = Vec::new();
    generate_combinations(arrays, &mut |combo| {
        results.push(combo.to_vec());
    });
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_combinations_c42() {
        let mut results: Vec<(Vec<&str>, Vec<&str>)> = Vec::new();
        select_combinations_from_array(
            &["a", "b", "c", "d"],
            2,
            2,
            &mut |selected, remaining| {
                results.push((selected.to_vec(), remaining.to_vec()));
            },
        );
        assert_eq!(results.len(), 6);
        for (selected, remaining) in &results {
            assert_eq!(selected.len(), 2);
            assert_eq!(remaining.len(), 2);
            let mut all: Vec<&str> = selected.iter().chain(remaining.iter()).copied().collect();
            all.sort();
            assert_eq!(all, vec!["a", "b", "c", "d"]);
        }
    }

    #[test]
    fn select_combinations_range() {
        let mut results: Vec<(Vec<i32>, Vec<i32>)> = Vec::new();
        select_combinations_from_array(&[1, 2, 3], 1, 2, &mut |s, r| {
            results.push((s.to_vec(), r.to_vec()));
        });
        // C(3,1) + C(3,2) = 3 + 3 = 6
        assert_eq!(results.len(), 6);
        let size1 = results.iter().filter(|(s, _)| s.len() == 1).count();
        let size2 = results.iter().filter(|(s, _)| s.len() == 2).count();
        assert_eq!(size1, 3);
        assert_eq!(size2, 3);
    }

    #[test]
    fn select_combinations_min_gt_len() {
        let mut results = Vec::new();
        select_combinations_from_array(&[1, 2], 3, 3, &mut |s, r| {
            results.push((s.to_vec(), r.to_vec()));
        });
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn select_combinations_clamp_max() {
        let mut results = Vec::new();
        select_combinations_from_array(&[1, 2], 2, 10, &mut |s, r| {
            results.push((s.to_vec(), r.to_vec()));
        });
        assert_eq!(results.len(), 1);
        assert_eq!(results[0], (vec![1, 2], vec![]));
    }

    #[test]
    fn generate_combinations_cartesian() {
        let arrays: Vec<Vec<&str>> = vec![vec!["a", "b"], vec!["1", "2"]];
        let results = generate_combinations_collect(&arrays);
        assert_eq!(
            results,
            vec![
                vec!["a", "1"],
                vec!["a", "2"],
                vec!["b", "1"],
                vec!["b", "2"],
            ]
        );
    }

    #[test]
    fn generate_combinations_single() {
        let arrays = vec![vec![1, 2, 3]];
        let results = generate_combinations_collect(&arrays);
        assert_eq!(results, vec![vec![1], vec![2], vec![3]]);
    }

    #[test]
    fn generate_combinations_empty_outer() {
        let arrays: Vec<Vec<i32>> = vec![];
        let results = generate_combinations_collect(&arrays);
        assert_eq!(results, vec![Vec::<i32>::new()]);
    }

    #[test]
    fn generate_combinations_empty_inner() {
        let arrays: Vec<Vec<i32>> = vec![vec![1, 2], vec![]];
        let results = generate_combinations_collect(&arrays);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn generate_combinations_three_arrays() {
        let arrays = vec![vec![1, 2], vec![3, 4], vec![5, 6]];
        let results = generate_combinations_collect(&arrays);
        assert_eq!(results.len(), 8);
    }
}
