/**
 * WASM web wrapper for retar.
 * ES module version of pkg/retar.js — uses async init() instead of fs.readFileSync.
 * The .wasm binary is shared with the Node.js build (../pkg/retar_bg.wasm).
 */

let wasm

// --- Internal glue (identical to pkg/retar.js) ---

let cachedDataViewMemory0 = null
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer)
  }
  return cachedDataViewMemory0
}

let cachedUint8ArrayMemory0 = null
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer)
  }
  return cachedUint8ArrayMemory0
}

const cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
cachedTextDecoder.decode()
function decodeText(ptr, len) {
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len))
}

function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0
  return decodeText(ptr, len)
}

const cachedTextEncoder = new TextEncoder()

let WASM_VECTOR_LEN = 0

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg)
    const ptr = malloc(buf.length, 1) >>> 0
    getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf)
    WASM_VECTOR_LEN = buf.length
    return ptr
  }

  let len = arg.length
  let ptr = malloc(len, 1) >>> 0

  const mem = getUint8ArrayMemory0()

  let offset = 0

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset)
    if (code > 0x7F) break
    mem[ptr + offset] = code
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset)
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len)
    const ret = cachedTextEncoder.encodeInto(arg, view)

    offset += ret.written
    ptr = realloc(ptr, len, offset, 1) >>> 0
  }

  WASM_VECTOR_LEN = offset
  return ptr
}

function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
      let deferred0_0
      let deferred0_1
      try {
        deferred0_0 = arg0
        deferred0_1 = arg1
        console.error(getStringFromWasm0(arg0, arg1))
      } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1)
      }
    },
    __wbg_new_227d7c05414eb861: function() {
      const ret = new Error()
      return ret
    },
    __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
      const ret = arg1.stack
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
      const len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbindgen_init_externref_table: function() {
      const table = wasm.__wbindgen_externrefs
      const offset = table.grow(4)
      table.set(0, undefined)
      table.set(offset + 0, undefined)
      table.set(offset + 1, null)
      table.set(offset + 2, true)
      table.set(offset + 3, false)
    },
  }
  return {
    __proto__: null,
    "./retar_bg.js": import0,
  }
}

// --- Public API ---

/**
 * Initialize the WASM module.
 * @param {string | URL | Response | BufferSource | WebAssembly.Module} source
 */
export async function init(source) {
  if (wasm) return

  const imports = __wbg_get_imports()

  let instance
  if (source instanceof WebAssembly.Module) {
    instance = new WebAssembly.Instance(source, imports)
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const module = new WebAssembly.Module(source)
    instance = new WebAssembly.Instance(module, imports)
  } else if (source instanceof Response || (typeof source === 'object' && source !== null && typeof source.then === 'function')) {
    const response = source instanceof Response ? source : await source
    const result = await WebAssembly.instantiateStreaming(response, imports)
    instance = result.instance
  } else {
    // string or URL — fetch it
    const response = await fetch(source)
    const result = await WebAssembly.instantiateStreaming(response, imports)
    instance = result.instance
  }

  wasm = instance.exports
  wasm.__wbindgen_start()
}

/**
 * @param {string} village_json
 * @param {string} setup_json
 * @param {string} options_json
 * @returns {string}
 */
export function analyze(village_json, setup_json, options_json) {
  if (!wasm) throw new Error('WASM not initialized — call init() first')
  let deferred4_0
  let deferred4_1
  try {
    const ptr0 = passStringToWasm0(village_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(setup_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
    const len1 = WASM_VECTOR_LEN
    const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc)
    const len2 = WASM_VECTOR_LEN
    const ret = wasm.analyze(ptr0, len0, ptr1, len1, ptr2, len2)
    deferred4_0 = ret[0]
    deferred4_1 = ret[1]
    return getStringFromWasm0(ret[0], ret[1])
  } finally {
    wasm.__wbindgen_free(deferred4_0, deferred4_1, 1)
  }
}
