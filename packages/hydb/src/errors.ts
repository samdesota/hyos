export type HyDBErrorValue =
  | string
  | number
  | boolean
  | null
  | readonly HyDBErrorValue[]
  | {readonly [key: string]: HyDBErrorValue}

export type HyDBErrorDetails = Readonly<Record<string, HyDBErrorValue>>

export type SerializedHyDBError = Readonly<{
  code: string
  message: string
  details?: HyDBErrorDetails
}>

export class HyDBError<Code extends string = string> extends Error {
  readonly code: Code
  readonly details?: HyDBErrorDetails

  constructor(code: Code, message: string = code, details?: Record<string, HyDBErrorValue>) {
    super(message)
    this.name = 'HyDBError'
    this.code = code
    this.details = details === undefined ? undefined : freezeDetails(details)
  }

  toJSON(): SerializedHyDBError {
    return this.details === undefined
      ? {code: this.code, message: this.message}
      : {code: this.code, message: this.message, details: this.details}
  }
}

export function error<Code extends string>(
  code: Code,
  message?: string,
  details?: Record<string, HyDBErrorValue>,
): HyDBError<Code> {
  return new HyDBError<Code>(code, message, details)
}

function freezeValue(value: HyDBErrorValue, seen: Set<object>): HyDBErrorValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('HyDB error details must contain finite numbers')
    return value
  }
  if (seen.has(value)) throw new TypeError('HyDB error details cannot contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) return Object.freeze(value.map(item => freezeValue(item, seen)))
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('HyDB error details must contain only JSON values')
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeValue(item, seen)]),
    ))
  } finally {
    seen.delete(value)
  }
}

function freezeDetails(details: Record<string, HyDBErrorValue>): HyDBErrorDetails {
  return freezeValue(details, new Set()) as HyDBErrorDetails
}

export function serializeError(value: unknown): SerializedHyDBError {
  if (value instanceof HyDBError) return value.toJSON()
  return {code: 'INTERNAL', message: 'Internal error'}
}
