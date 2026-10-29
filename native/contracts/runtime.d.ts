import type {
  MethodName,
  MethodParams,
  MethodResult,
  EventName,
  EventData,
  ReplyEnvelope,
  RequestEnvelope,
  EventEnvelope,
  Definitions,
  ErrorData,
  ValidationIssue,
} from './types'
export {
  MethodName,
  MethodParams,
  MethodResult,
  EventName,
  EventData,
  ReplyEnvelope,
  RequestEnvelope,
  EventEnvelope,
  Definitions,
  ErrorData,
  ValidationIssue,
}
export class ContractError extends Error {
  readonly name: 'ContractError'
  readonly code: string
  readonly path: string
  readonly issues: ValidationIssue[]
  constructor(message: string, issues?: ValidationIssue[], code?: string)
}
export const limits: Readonly<{
  maxDepth: number
  maxNodes: number
  maxStringLength: number
  maxTotalStringLength: number
  maxSchemaSteps: number
}>
export const manifest: Readonly<{
  methods: Readonly<
    Record<
      MethodName,
      { owner: 'backend' | 'shell'; params: { $ref: string }; result: { $ref: string }; availability?: string }
    >
  >
  events: Readonly<Record<EventName, { owner: 'backend' | 'shell'; data: { $ref: string } }>>
  schemaVersions: Readonly<Record<string, number | ReadonlyArray<number | string>>>
}>
export const schema: Readonly<Record<string, unknown>>
export function validateRequest(request: unknown): RequestEnvelope
export function validateParams<M extends MethodName>(method: M, params?: unknown): MethodParams<M>
export function validateParams(method: string, params?: unknown): unknown
export function validateResult<M extends MethodName>(method: M, result: unknown): MethodResult<M>
export function validateResult(method: string, result: unknown): unknown
export function validateReply<M extends MethodName>(method: M, reply: unknown): ReplyEnvelope<M>
export function validateReply(method: string, reply: unknown): ReplyEnvelope
export function validateEvent<E extends EventName>(event: { event: E; data?: unknown }): EventEnvelope<E>
export function validateEvent(event: unknown): EventEnvelope
export function validateProject(project: unknown): Definitions['PersistedProject']
export function validateDefinition<N extends keyof Definitions>(name: N, value: unknown): Definitions[N]
/** An error carrying the recovery details serializeError copies into its reply (see ErrorData). */
export type RecoverableError = Error &
  Partial<Omit<ErrorData, 'error' | 'code' | 'details' | 'cleanupError' | 'releaseError' | 'closeErrors'>> & {
    code?: string
    cleanupError?: unknown
    releaseError?: unknown
    closeErrors?: unknown[]
  }
export function serializeError(error: unknown): ErrorData
