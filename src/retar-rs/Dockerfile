FROM rust:1.94-slim

RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack

WORKDIR /app

ENTRYPOINT ["bash"]
