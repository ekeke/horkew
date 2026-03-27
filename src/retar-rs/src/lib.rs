use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn analyze(village_json: &str, setup_json: &str, options_json: &str) -> String {
    // TODO: implement
    String::from("{}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dummy_analyze_returns_empty_object() {
        let result = analyze("{}", "{}", "{}");
        assert_eq!(result, "{}");
    }
}
