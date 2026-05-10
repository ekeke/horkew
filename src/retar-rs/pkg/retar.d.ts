/* tslint:disable */
/* eslint-disable */

/**
 * WASM entry point: takes JSON strings, returns JSON string.
 *
 * Input:  village_json, setup_json, options_json
 * Output: JSON object {"1": ["seer", "villager"], "2": ["werewolf"], ...}
 */
export function analyze(village_json: string, setup_json: string, options_json: string): string;
