import type { Duration } from "./duration.ts";
import type { AnySchema, InferIn, InferOut } from "./schema.ts";
import type { CheckDefinition, CheckResult, Risk } from "./types.ts";

/** A run-owned branch. Preparation commands must be safe to repeat after interruption. */
export interface WorkspaceOptions {
  branch: string;
  from?: string;
  prepare?: readonly (readonly [string, ...string[]])[];
  /** Extra file inputs (for example ignored preparation metadata) whose bytes invalidate proof. */
  fingerprintFiles?: readonly string[];
}

declare const candidateBrand: unique symbol;
/** Engine-issued immutable identity; copying its fields does not grant candidate authority. */
export interface WorkspaceCandidate {
  readonly id: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
  readonly tree: string;
  readonly generation: number;
  /** Runtime/platform, workspace declaration, and explicitly declared non-tree file inputs. */
  readonly environment: string;
  readonly [candidateBrand]: true;
}

declare const verificationBrand: unique symbol;
export interface VerificationProof {
  readonly id: string;
  readonly candidateId: string;
  readonly checks: readonly string[];
  readonly [verificationBrand]: true;
}

export interface VerificationResult {
  readonly candidate: WorkspaceCandidate;
  readonly results: Readonly<Record<string, CheckResult>>;
  readonly passed: boolean;
  /** Present only after every check executes and passes against this exact candidate. */
  readonly proof?: VerificationProof;
}

export interface WorkspaceApi {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  /** Requires a clean committed tree; always observes current host state. */
  snapshot(options: { key: string }): Promise<WorkspaceCandidate>;
  assertCurrent(candidate: WorkspaceCandidate): Promise<void>;
}

export interface VerificationOptions {
  key: string;
  timeout?: Duration;
}

export type VerifyFn = (
  candidate: WorkspaceCandidate,
  checks: readonly CheckDefinition<void>[],
  options: VerificationOptions,
) => Promise<VerificationResult>;

export interface OperationDefinition<Input, Output, ParsedInput = Input> {
  readonly kind: "weft.operation";
  readonly name: string;
  readonly revision: string;
  readonly binding: string;
  readonly input: AnySchema;
  readonly output: AnySchema;
  readonly risk: Risk;
  readonly __input?: Input;
  readonly __parsedInput?: ParsedInput;
  readonly __output?: Output;
}

export interface OperationOptions {
  key: string;
  /** Identity within this run and host binding. Reuse with different input is refused. */
  requestId?: string;
  /** Bounds host execution/reconciliation; interrupted intents still require reconciliation. */
  timeout?: Duration;
}

export interface OperationReceipt<Output> {
  readonly value: Output;
  readonly requestId: string;
  readonly binding: string;
  readonly reconciled: boolean;
}

export type OperationFn = <Input, Output, ParsedInput>(
  definition: OperationDefinition<Input, Output, ParsedInput>,
  input: Input,
  options: OperationOptions,
) => Promise<OperationReceipt<Output>>;

export interface DeliveryOptions extends OperationOptions {
  candidate: WorkspaceCandidate;
  proofs: readonly VerificationProof[];
  /** Optional mandatory human approval in addition to host risk policy. */
  approval?: { question: string; timeout?: Duration };
}

export type DeliveryFn = <Input, Output, ParsedInput>(
  definition: OperationDefinition<Input, Output, ParsedInput>,
  input: Input,
  options: DeliveryOptions,
) => Promise<OperationReceipt<Output>>;

/** Definitions name trusted host bindings; workflow code never supplies the external executor. */
export function defineOperation<I extends AnySchema, O extends AnySchema>(config: {
  name: string;
  revision: string;
  binding: string;
  input: I;
  output: O;
  risk?: Risk;
}): OperationDefinition<InferIn<I>, InferOut<O>, InferOut<I>> {
  for (const field of ["name", "revision", "binding"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim())
      throw new TypeError(`defineOperation: ${field} is required`);
  }
  if (!config.input?.["~standard"]?.validate || !config.output?.["~standard"]?.validate) {
    throw new TypeError("defineOperation: input and output must be Standard Schemas");
  }
  if (config.risk !== undefined && !["low", "medium", "high", "irreversible"].includes(config.risk)) {
    throw new TypeError("defineOperation: risk must be a known risk tier");
  }
  return Object.freeze({ kind: "weft.operation", ...config, risk: config.risk ?? "high" });
}

/** Delivery uses the same recoverable operation kernel plus candidate/proof enforcement. */
export const defineDelivery: typeof defineOperation = defineOperation;
