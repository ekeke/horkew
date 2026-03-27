use wasm_bindgen::prelude::*;

pub mod types;
pub mod possibilities;

#[wasm_bindgen]
pub fn analyze(_village_json: &str, _setup_json: &str, _options_json: &str) -> String {
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
