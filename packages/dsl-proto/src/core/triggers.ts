/** Declaration-only authenticated external-trigger surface for the Weft DSL prototype. */

import type { AnySchema, HostBinding, InferIn, InferOut, WorkflowNode } from "./shared.ts";
import type { InferWorkflowInput, WorkflowDefinition } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Authenticated sources and pure event routing
// ---------------------------------------------------------------------------

/**
 * Why: Names the host adapter that authenticates and delivers external events before schema validation.
 * Use: Bind a connector such as a verified webhook receiver; the host must reject unauthenticated payloads.
 */
export interface AuthenticatedTriggerSource {
  readonly binding: HostBinding;
}

/**
 * Why: Keeps event filtering deterministic and independent from workflow effects or workspace state.
 * Use: Return `false` for valid events that should be acknowledged without admitting a workflow run.
 */
export type TriggerEventFilter<Event> = (event: Event) => boolean;

/**
 * Why: Extracts the provider's stable event identity separately from its cross-run deduplication policy.
 * Use: Return a non-empty delivery, message, or event ID from the schema-validated event.
 */
export type TriggerEventIdentity<Event> = (event: Event) => string;

/**
 * Why: Defines the stable identity on which the engine atomically claims at-most-one workflow launch.
 * Use: Include every tenant or repository dimension needed to prevent unrelated events from colliding.
 */
export type TriggerDedupeIdentity<Event> = (event: Event) => string;

/**
 * Why: Couples pure event normalization directly to the raw input accepted by one specific workflow.
 * Use: Return only data derived from the validated event; the engine validates the result before claiming a run.
 */
export type TriggerEventMapper<Event, Workflow extends WorkflowDefinition<any, any, any, any, any>> = (
  event: Event,
) => InferWorkflowInput<Workflow>;

// ---------------------------------------------------------------------------
// Trigger definitions
// ---------------------------------------------------------------------------

/**
 * Why: Fixes validation-before-claim and recoverable claim, child-run, and outbox creation as engine invariants.
 * Use: Read it from a definition for inspection; authors cannot weaken or replace this sequence with scheduler policy.
 */
export interface TriggerAdmissionSemantics {
  readonly mode: "atomic-claim-before-launch";
  readonly mappedInput: "validate-before-claim";
  readonly transaction: "claim-run-outbox";
}

/**
 * Why: Binds one authenticated source and event schema to exactly one mapped workflow contract.
 * Use: Create it with `defineTrigger`; registries subscribe its source while engines enforce atomic admission.
 */
export interface TriggerDefinition<
  Name extends string = string,
  Revision extends string = string,
  EventSchema extends AnySchema = AnySchema,
  Workflow extends WorkflowDefinition<any, any, any, any, any> = WorkflowDefinition<any, any, any, any, any>,
> extends WorkflowNode<"weft.trigger"> {
  readonly kind: "weft.trigger";
  readonly name: Name;
  readonly revision: Revision;
  readonly description?: string;
  readonly source: Readonly<AuthenticatedTriggerSource>;
  readonly event: EventSchema;
  readonly workflow: Workflow;
  readonly filter?: TriggerEventFilter<InferOut<EventSchema>>;
  readonly eventId: TriggerEventIdentity<InferOut<EventSchema>>;
  readonly dedupeKey: TriggerDedupeIdentity<InferOut<EventSchema>>;
  readonly map: TriggerEventMapper<InferOut<EventSchema>, Workflow>;
  readonly admission: Readonly<TriggerAdmissionSemantics>;
}

/**
 * Why: Collects the portable trigger contract without exposing scheduler or admission-policy configuration.
 * Use: Supply pure selectors and mapping; authentication, validation, atomic claim, and launch belong to the engine.
 */
export interface TriggerConfig<
  Name extends string,
  Revision extends string,
  EventSchema extends AnySchema,
  Workflow extends WorkflowDefinition<any, any, any, any, any>,
> {
  name: Name;
  revision: Revision;
  description?: string;
  source: AuthenticatedTriggerSource;
  event: EventSchema;
  workflow: Workflow;
  filter?: TriggerEventFilter<InferOut<EventSchema>>;
  eventId: TriggerEventIdentity<InferOut<EventSchema>>;
  dedupeKey: TriggerDedupeIdentity<InferOut<EventSchema>>;
  map: TriggerEventMapper<InferOut<EventSchema>, NoInfer<Workflow>>;
}

/**
 * Why: Declares authenticated event admission without starting a subscription or exposing it through workflow context.
 * Use: Register it with the host, which authenticates and validates the event, binds ID to payload digest, filters,
 * maps and validates workflow input, then atomically creates the revision-scoped claim, child run, and launch outbox.
 */
export declare function defineTrigger<
  const Name extends string,
  const Revision extends string,
  EventSchema extends AnySchema,
  Workflow extends WorkflowDefinition<any, any, any, any, any>,
>(
  config: TriggerConfig<Name, Revision, EventSchema, Workflow>,
): TriggerDefinition<Name, Revision, EventSchema, Workflow>;

// ---------------------------------------------------------------------------
// Engine-minted admission and suppression outcomes
// ---------------------------------------------------------------------------

/**
 * Why: Prevents ordinary accepted-looking records from masquerading as proof that the engine claimed and launched a run.
 * Use: It is carried only by `WorkflowAdmission` values minted in the atomic claim-and-launch transaction.
 */
declare const workflowAdmissionBrand: unique symbol;

/**
 * Why: Binds the provider event identity to the digest of the exact authenticated, schema-validated payload.
 * Use: Carry it through filtered, duplicate, and accepted outcomes so event IDs cannot float across payload bytes.
 */
export interface TriggerEventProvenance<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> {
  readonly trigger: Definition["name"];
  readonly revision: Definition["revision"];
  readonly definitionDigest: string;
  readonly source: Definition["source"]["binding"];
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly receivedAt: string;
}

/**
 * Why: Makes the atomic deduplication namespace include immutable definition identity rather than a key alone.
 * Use: Claim the tuple of trigger definition digest, declared revision, and computed dedupe key exactly once.
 */
export interface TriggerClaimIdentity<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> {
  readonly triggerDefinitionDigest: string;
  readonly triggerRevision: Definition["revision"];
  readonly dedupeKey: string;
}

/**
 * Why: Prevents mapped workflow input or user-authored strings from impersonating authenticated trigger provenance.
 * Use: Read it from `ctx.run.trigger` inside an admitted workflow when source identity affects authorization decisions.
 */
declare const triggerRunProvenanceBrand: unique symbol;

/**
 * Why: Carries authenticated ingress identity into the child run without exposing the original event payload.
 * Use: Inspect its digests and source binding, or re-resolve authoritative context before consequential work.
 */
export interface TriggerRunProvenance<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> {
  readonly admissionRef: string;
  readonly transactionRef: string;
  readonly provenance: Readonly<TriggerEventProvenance<Definition>>;
  readonly claim: Readonly<TriggerClaimIdentity<Definition>>;
  readonly [triggerRunProvenanceBrand]: Definition;
}

/**
 * Why: Correlates one accepted claim with the validated workflow input, allocated child run, and durable launch outbox.
 * Use: Recover or audit launch delivery without exposing the mapped workflow input itself.
 */
export interface AdmittedWorkflowRun {
  readonly runId: string;
  readonly workflowDefinitionDigest: string;
  readonly workflowInputDigest: string;
  readonly outboxRef: string;
}

/**
 * Why: Attests that one validated event and mapped input were atomically claimed for one trigger-bound workflow run.
 * Use: Retain it for audit and correlation; the nominal brand covers its provenance, claim, run, and outbox metadata.
 */
export interface WorkflowAdmission<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> {
  readonly status: "accepted";
  readonly ref: string;
  readonly transactionRef: string;
  readonly provenance: Readonly<TriggerEventProvenance<Definition>>;
  readonly claim: Readonly<TriggerClaimIdentity<Definition>>;
  readonly run: Readonly<AdmittedWorkflowRun>;
  readonly admittedAt: string;
  readonly [workflowAdmissionBrand]: Definition;
}

/**
 * Why: Reports that a valid authenticated event intentionally did not pass its trigger's pure filter.
 * Use: Acknowledge the source event without creating a dedupe claim, workspace, or workflow run.
 */
export interface FilteredTriggerEvent<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> {
  readonly status: "filtered";
  readonly provenance: Readonly<TriggerEventProvenance<Definition>>;
  readonly filteredAt: string;
}

/**
 * Why: Reports that the engine found an existing atomic claim for the trigger's computed deduplication key.
 * Use: Acknowledge the delivery without launching again; correlate to `existingRunId` when the host can disclose it.
 */
export interface DuplicateTriggerEvent<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> {
  readonly status: "duplicate";
  readonly provenance: Readonly<TriggerEventProvenance<Definition>>;
  readonly claim: Readonly<TriggerClaimIdentity<Definition>>;
  readonly workflowInputDigest: string;
  readonly existingRunId?: string;
  readonly suppressedAt: string;
}

/**
 * Why: Gives non-admitted authenticated events one exhaustive typed outcome without treating suppression as authority.
 * Use: Narrow on `status` to distinguish an intentional filter decision from an existing atomic claim.
 */
export type TriggerSuppressionResult<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> = FilteredTriggerEvent<Definition> | DuplicateTriggerEvent<Definition>;

/**
 * Why: Represents every terminal result of authenticating, validating, routing, and attempting to admit one event.
 * Use: Return it from the internal trigger handler after filter or one atomic claim-before-launch decision.
 */
export type TriggerAdmissionResult<
  Definition extends TriggerDefinition<any, any, any, any> = TriggerDefinition<any, any, any, any>,
> = WorkflowAdmission<Definition> | TriggerSuppressionResult<Definition>;

// ---------------------------------------------------------------------------
// Internal invocation inference
// ---------------------------------------------------------------------------

/**
 * Why: Recovers the raw event payload accepted before a trigger's schema validation boundary.
 * Use: Supply the input side of an internal authenticated trigger invocation.
 */
export type TriggerInputOf<Definition> =
  Definition extends TriggerDefinition<any, any, infer EventSchema, any> ? InferIn<EventSchema> : never;

/**
 * Why: Recovers the exact admitted-or-suppressed result tied to one trigger definition.
 * Use: Supply the output side of an internal trigger invocation while preserving its nominal admission type.
 */
export type TriggerOutputOf<Definition> =
  Definition extends TriggerDefinition<any, any, any, any> ? TriggerAdmissionResult<Definition> : never;
