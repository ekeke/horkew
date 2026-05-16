/**
 * skoll モジュール共通定数
 */

/**
 * 世界列挙 (`enumerateWorlds` / backtrack) の打ち切り上限。
 * `analyzeExecutionsByWorld` / `analyzeHamsterVotesByWorld` / `analyzeAttacksByWorld` /
 * `computeRoleProbabilities` などの `maxWorlds` パラメータの default 値。
 *
 * 14D-neko (14人村・猫又入り) の全 vote 局面で truncate なくカバーできる上限として 2M に設定。
 */
export const DEFAULT_MAX_WORLDS = 2_000_000
