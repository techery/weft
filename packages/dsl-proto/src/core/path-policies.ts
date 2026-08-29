/** Declaration-only path authority surface for the Weft DSL prototype. */

import type { Duration, WorkflowNode, WorkspaceSnapshotRef } from "./shared.ts";

// ---------------------------------------------------------------------------
// Fixed path policies
// ---------------------------------------------------------------------------

/**
 * Why: Makes the immutable boundary for dynamically proposed write paths inspectable before any grant exists.
 * Use: Create one with `definePathPolicy`; roots are workspace-relative path prefixes and deny entries are globs.
 */
export interface PathPolicyDefinition<Name extends string = string, Revision extends string = string>
  extends WorkflowNode<"weft.path-policy"> {
  readonly kind: "weft.path-policy";
  readonly name: Name;
  readonly description?: string;
  readonly revision: Revision;
  readonly roots: readonly [string, ...string[]];
  readonly deny: readonly string[];
  readonly grantTtl: Duration;
}

/**
 * Why: Keeps broad author-owned limits separate from narrower paths proposed later by agents or external inputs.
 * Use: Declare at least one fixed workspace-relative root, immutable deny globs, and a bounded grant lifetime.
 */
export interface PathPolicyConfig<Name extends string = string, Revision extends string = string> {
  name: Name;
  description?: string;
  revision: Revision;
  roots: readonly [string, ...string[]];
  deny?: readonly string[];
  grantTtl: Duration;
}

/**
 * Why: Declares canonical path limits without resolving paths or granting write authority at module load time.
 * Use: Define policies beside workflows, then pass the returned node to `ctx.paths.resolve` for each proposal.
 */
export declare function definePathPolicy<const Name extends string, const Revision extends string>(
  config: PathPolicyConfig<Name, Revision>,
): PathPolicyDefinition<Name, Revision>;

// ---------------------------------------------------------------------------
// Engine-minted grants and write scopes
// ---------------------------------------------------------------------------

/**
 * Why: Prevents structurally similar policy names, paths, and timestamps from masquerading as write authority.
 * Use: It is carried only by `PathGrantRef` values minted after engine-controlled path resolution.
 */
declare const pathGrantRefBrand: unique symbol;

/**
 * Why: Binds canonical allowed paths to one policy revision, request digest, workspace generation, and lifetime.
 * Use: Retain it for audit or pass it through trusted orchestration; use its enclosing `WriteScope` for mutation.
 */
export interface PathGrantRef<Policy extends PathPolicyDefinition = PathPolicyDefinition> {
  readonly ref: string;
  readonly policy: Policy["name"];
  readonly revision: Policy["revision"];
  readonly requestDigest: string;
  readonly subject: WorkspaceSnapshotRef;
  readonly paths: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly [pathGrantRefBrand]: Policy;
}

/**
 * Why: Prevents a workflow from reconstructing an accepted write scope from an ordinary path array or grant-shaped data.
 * Use: It is carried only by strict scopes returned from `PathPolicyApi.resolve` and consumed unchanged by writers.
 */
declare const writeScopeBrand: unique symbol;

/**
 * Why: Gives writer APIs one strict, engine-verifiable capability instead of ambient or prompt-described path access.
 * Use: Pass the complete value to an agent or workspace mutation API; do not project it back into a path array.
 */
export interface WriteScope<Policy extends PathPolicyDefinition = PathPolicyDefinition> {
  readonly mode: "strict";
  readonly grant: PathGrantRef<Policy>;
  readonly paths: readonly string[];
  readonly [writeScopeBrand]: Policy;
}

// ---------------------------------------------------------------------------
// Dynamic resolution
// ---------------------------------------------------------------------------

/**
 * Why: Labels untrusted dynamic paths as a proposal that cannot itself confer mutation authority.
 * Use: Supply model-, issue-, or discovery-produced paths; resolution rejects an empty or partly disallowed set.
 */
export interface PathPolicyRequest {
  proposedPaths: readonly string[];
}

/**
 * Why: Gives each path-resolution effect stable replay identity without allowing calls to weaken fixed policy.
 * Use: Pass a deterministic key and optional human-readable label to `PathPolicyApi.resolve`.
 */
export interface PathPolicyResolveOptions {
  key: string;
  label?: string;
}

/**
 * Why: Centralizes canonicalization, traversal and symlink checks, root containment, deny matching, and grant minting.
 * Use: Call `ctx.paths.resolve(policy, request, options)`; consume the returned scope only on the same subject before expiry.
 */
export interface PathPolicyApi {
  resolve<Policy extends PathPolicyDefinition>(
    policy: Policy,
    request: PathPolicyRequest,
    options: PathPolicyResolveOptions,
  ): Promise<WriteScope<Policy>>;
}
