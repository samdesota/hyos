import {HyDBError} from '../errors.js'

type CanonicalValue =
  | ['null']
  | ['boolean', boolean]
  | ['number', string]
  | ['string', string]
  | ['date', string]
  | ['array', CanonicalValue[]]
  | ['object', Array<[string, CanonicalValue]>]

function canonicalValue(value: unknown, seen: Set<object>): CanonicalValue {
  if (value === null) return ['null']
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HyDBError('VALUE_NOT_SERIALIZABLE', 'Numbers must be finite')
    }
    return ['number', Object.is(value, -0) ? '0' : String(value)]
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new HyDBError('VALUE_NOT_SERIALIZABLE', 'Dates must be valid')
    }
    return ['date', value.toISOString()]
  }
  if (typeof value !== 'object') {
    throw new HyDBError(
      'VALUE_NOT_SERIALIZABLE',
      `Unsupported value type: ${typeof value}`,
    )
  }
  if (seen.has(value)) {
    throw new HyDBError('VALUE_NOT_SERIALIZABLE', 'Cyclic values are not supported')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return ['array', value.map(item => canonicalValue(item, seen))]
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new HyDBError(
        'VALUE_NOT_SERIALIZABLE',
        'Only plain objects, arrays, dates, and primitives are supported',
      )
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key): [string, CanonicalValue] => [
        key,
        canonicalValue((value as Record<string, unknown>)[key], seen),
      ])
    return ['object', entries]
  } finally {
    seen.delete(value)
  }
}

function revive(value: CanonicalValue): unknown {
  switch (value[0]) {
    case 'null': return null
    case 'boolean': return value[1]
    case 'number': return Number(value[1])
    case 'string': return value[1]
    case 'date': return new Date(value[1])
    case 'array': return value[1].map(revive)
    case 'object': return Object.fromEntries(value[1].map(([key, item]) => [key, revive(item)]))
  }
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()))
}

export function canonicalParse(value: string): unknown {
  try {
    return revive(JSON.parse(value) as CanonicalValue)
  } catch (cause) {
    if (cause instanceof HyDBError) throw cause
    throw new HyDBError('INVALID_ENCODING', 'The encoded value is malformed')
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(value))
}

export function parseCanonicalBytes(value: Uint8Array): unknown {
  try {
    return canonicalParse(new TextDecoder('utf-8', {fatal: true}).decode(value))
  } catch (cause) {
    if (cause instanceof HyDBError) throw cause
    throw new HyDBError('INVALID_ENCODING', 'The encoded value is not valid UTF-8')
  }
}

export function assertSerializable(value: unknown): void {
  canonicalValue(value, new Set())
}

export function cloneCanonical(value: unknown): unknown {
  return canonicalParse(canonicalStringify(value))
}

// Small synchronous SHA-256 implementation keeps schema assembly isomorphic and
// avoids turning the definition-only `hydb.database` API into an async operation.
export function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const input = new Uint8Array(paddedLength)
  input.set(bytes)
  input[bytes.length] = 0x80
  const view = new DataView(input.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const words = new Uint32Array(64)
  const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits))

  for (let offset = 0; offset < input.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!
      const b = words[index - 2]!
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number]
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choice + constants[index]! + words[index]!) >>> 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, h]
    for (let index = 0; index < 8; index++) state[index] = (state[index]! + next[index]!) >>> 0
  }
  return state.map(word => word.toString(16).padStart(8, '0')).join('')
}
