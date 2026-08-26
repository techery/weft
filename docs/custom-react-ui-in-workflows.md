# Custom React UI inside Weft workflows

> Implementation article for Weft's first custom workflow UI release. The public API and runtime contracts below describe the code in this repository. The final section separates automated coverage from the broader browser matrix required before a production release.

Weft workflows can now render custom React components while they run.

Today, when a workflow needs human input, the Workflow Manager generates a form from the step's JSON Schema. That remains the default and the permanent fallback. But some interactions need more than generic fields: reviewing a deployment, comparing candidates, annotating an artifact, or exploring a structured result all benefit from purpose-built UI.

Workflow UI views add that escape hatch without moving workflow execution into the browser. An author places a `.ui.tsx` component beside a workflow and imports it like any other TypeScript module. Weft compiles the file into a browser asset, journals an immutable presentation descriptor, and renders it inside constrained host-owned chrome.

The same mechanism supports three use cases:

- A custom view for a pending human question.
- A read-only presentation of a validated step result.
- A composed presentation built from several workflow results.

## Defining an input view

A workflow imports its UI view directly. There is no string path or runtime component registry for authors to keep in sync:

```ts
import deploymentReview from "./deployment-review.ui.tsx";

export default defineWorkflow(
  {
    id: "deploy",
    description: "Prepare and review a deployment",
    input: DeployInput,
    output: DeployOutput,
  },
  async (ctx, input) => {
    const decision = await ctx.human.ask({
      key: "deployment-review",
      question: "Review this deployment",
      schema: DeploymentDecision,
      ui: {
        view: deploymentReview,
        props: {
          environment: input.environment,
          services: input.services,
        },
      },
    });

    return decision;
  },
);
```

The companion component is ordinary React, with two important pieces of static metadata: a stable `id` and a semantic `revision`.

```tsx
import { defineUiView, type InputViewProps } from "@techery/weft-sdk/ui";
import { useState } from "react";
import { z } from "zod";
import { DeploymentDecision } from "./schemas.js";

type Props = {
  environment: string;
  services: string[];
};

type Answer = z.input<typeof DeploymentDecision>;

function DeploymentReview({ props, propose }: InputViewProps<Props, Answer>) {
  const [selected, setSelected] = useState(props.services);

  const toggle = (service: string) => {
    setSelected((current) =>
      current.includes(service)
        ? current.filter((candidate) => candidate !== service)
        : [...current, service],
    );
  };

  return (
    <section>
      <h2>Deploy to {props.environment}</h2>

      {props.services.map((service) => (
        <label key={service}>
          <input
            type="checkbox"
            checked={selected.includes(service)}
            onChange={() => toggle(service)}
          />
          {service}
        </label>
      ))}

      <button onClick={() => propose({ approvedServices: selected })}>
        Stage this selection
      </button>
    </section>
  );
}

export default defineUiView<Props, Answer>({
  id: "deployment-review",
  revision: "1",
  component: DeploymentReview,
});
```

`propose()` deliberately does not answer the workflow. It sends a candidate value to the parent Workflow Manager, which validates it and shows the exact candidate in host-owned chrome. A person must use the host's **Submit and resume** control before Weft records the answer. Component code therefore cannot answer a question on mount or falsely turn an automated action into a human decision.

The answer type is the schema's input type, while workflow code receives the schema's output type. That distinction matters for defaults, coercions, and transforms. The server remains responsible for applying the authoritative schema.

The `id` and `revision` must be string literals so the compiler can extract them without executing browser code. TypeScript checks the props and candidate answer, while the Weft compiler independently checks the static metadata, import policy, and bundle limits.

## Rendering step results

Custom views are not limited to human input. A workflow can publish a read-only presentation after a step returns a validated result:

```ts
import analysisView from "./analysis-result.ui.tsx";

const analysis = await ctx.agent("Analyze deployment risk", {
  key: "deployment-analysis",
  schema: DeploymentAnalysis,
});

await ctx.ui.render({
  key: "render-deployment-analysis",
  slot: "deployment-analysis",
  view: analysisView,
  props: {
    riskScore: analysis.riskScore,
    findings: analysis.findings,
  },
});
```

The component receives an explicit, JSON-safe projection of the validated result:

```tsx
import { defineResultView } from "@techery/weft-sdk/ui";

type Props = {
  riskScore: number;
  findings: Array<{ title: string; severity: string }>;
};

export default defineResultView<Props>({
  id: "deployment-analysis",
  revision: "1",
  component({ props }) {
    return <RiskDashboard score={props.riskScore} findings={props.findings} />;
  },
});
```

This explicit second operation is intentional for v1. Adding `ui` to the agent's computational payload would make a visual revision invalidate and rerun an expensive agent step. `ctx.ui.render()` is instead its own replayable presentation step. The producing step and its presentation can refer to one another in the timeline without sharing replay identity.

A later convenience API may accept `ui` on a step and desugar it into the same separate presentation occurrence after validation. It must not change the computational step hash.

The standard JSON, Markdown, artifact, or other result renderer is always available beside the custom view. A result view is an interpretation of durable output, never its source of truth.

## Rendering composed workflow state

The same primitive can render a presentation assembled from several results:

```ts
import summaryView from "./workflow-summary.ui.tsx";

const analysis = await ctx.agent(/* ... */);
const checks = await Promise.all([
  ctx.check("unit-tests", { exec: ["pnpm", "test"] }),
  ctx.check("typecheck", { exec: ["pnpm", "typecheck"] }),
]);

await ctx.ui.render({
  key: "render-deployment-summary",
  slot: "deployment-summary",
  view: summaryView,
  props: { analysis, checks },
});
```

`key` and `slot` have different jobs:

- `key` is the durable call-site identity used for replay and should be unique to that call site.
- `slot` is optional grouping metadata for hosts that want to select the current presentation for a named region.

The current Workflow Manager shows each presentation on its journaled timeline step and retains `slot` for future aggregate surfaces. It does not discard earlier occurrences. Authors must not reuse a `key` across unrelated call sites because that would conflate replay identity.

## The durable presentation contract

Input and display views use one versioned contract:

```ts
type UiAssetRef = {
  id: string;
  revision: string;
  bundleRef: BlobRefJson;
  protocol: 1;
};

type UiProps =
  | { inline: JsonValue; hash: string }
  | { ref: BlobRefJson; hash: string };

type UiPresentation = {
  asset: UiAssetRef;
  props: UiProps;
  mode: "display" | "input";
  slot?: string;
};
```

Large props are stored once in the blob store rather than copied into an unbounded journal event. The blob is written and verified before the event that references it is appended. Props are durable run data: they must be JSON-safe and size-bounded, and must not contain credentials, tokens, secrets, or transient privileged handles.

The descriptor is recorded in an existing durable lifecycle:

- `human.requested` may carry an input presentation.
- The `step.completed` event for a replayable UI presentation step carries a display presentation.
- A future step-attachment convenience API may associate that presentation with its producing step.

V1 does not need a fire-and-forget `ui.rendered` event. `ctx.ui.render()` is a new replay-aware step kind whose semantic hash includes its call-site key, slot, view ID, revision, and canonical props hash. It excludes `bundleRef`, so a bundle-only visual change does not alter replay identity. UI steps also opt out of the existing reuse-by-key cache behavior that could otherwise return stale props.

For human steps, the journal must record the human `key` as well as the view ID, revision, props hash, and answer schema identity. If one of those semantic inputs changes, Weft creates a new request and records the previous same-key request as superseded. The pending-request projection and answer endpoint must reject superseded request IDs; otherwise both the old and new questions would remain answerable.

## Why the component is a TypeScript import

The direct import is authoring syntax, not the browser's runtime lookup mechanism.

Weft gives a `.ui.tsx` import two meanings during compilation:

```text
deployment-review.ui.tsx
          │
          ├── Node workflow graph → inert typed token
          │
          └── Browser asset graph → bundled React application
```

The Node graph intercepts the import before the React module enters the workflow's deterministic module graph. It statically validates the literal `id` and `revision`, records them in the compiled UI catalog, and emits an opaque token similar to:

```ts
{
  kind: "weft.ui-view",
  assetKey: "module-scoped-compiler-key",
}
```

The token contains no executable component, semantic revision, or blob reference. It is safe to pass through workflow code, and changing UI source or metadata does not alter the workflow definition hash. When a presentation is created, the runtime resolves the token through the sealed catalog and includes the catalog's current view ID and revision in that presentation's own semantic hash.

Separately, the browser compiler follows the real module, transforms JSX, bundles it with compiler-owned React dependencies, and produces a content-addressed asset. A compiled UI catalog maps the internal `assetKey` to the exact browser asset and its hash. The workflow cannot invent or override a `bundleRef`; only the sealed compiler catalog can resolve one.

This gives authors rename support, navigation, autocomplete, prop checking, and an explicit dependency graph, without putting React or browser APIs into Node workflow execution.

## Two hashes, not one

UI compilation needs two independent identities:

- `defHash` covers emitted Node workflow code and continues to govern workflow replay trust.
- `buildHash` covers the UI catalog and browser outputs and governs loader and registry caching.

Putting browser metadata or a bundle hash into the Node token would make a UI change alter `defHash` and invalidate replay positions across the workflow. Looking only at `defHash` in the registry cache would have the opposite bug: UI edits would keep serving an old browser bundle. The two-hash model avoids both failures.

The compiled catalog is a first-class build result, not metadata hidden on the workflow definition. It must travel through bundle, load, registry resolution, host resolution, engine start and resume, and named-child resolution. Wrappers that reconstruct a workflow definition must not be able to discard it.

## Durable assets and entry-point boundaries

Before a run records its first presentation, Weft stores the browser bytes content-addressably and journals the exact asset reference. Historical rendering is exact only while every referenced blob is retained. Garbage collection, run export, import, and deletion therefore need to trace and preserve presentation references just like other durable artifacts. If an asset is missing or corrupt, the host shows the standard renderer and an explicit unavailable state.

The implementation carries the UI catalog through every workflow entry point that can compile browser views:

- File and registry workflows receive their catalog from the gate and registry resolver.
- Inline, STDIN, and MCP-created workflows persist browser assets and a run-local `ui-manifest.json`, so a later process can resume with the same component bytes.
- Named child workflows use the richer resolver result and receive their own catalog; inline children inherit the parent catalog.
- Direct engine callers pass `uiCatalog` alongside the `WorkflowDefinition`, which keeps the runtime contract explicit in tests and embedding applications.

An imported view that is absent from the sealed catalog is rejected before it can create a presentation. Weft never starts rendering from a path supplied at runtime.

## Failure semantics

Presentation failures are isolated from already-completed computation, but not every UI-related error is cosmetic:

- A compile error, duplicate view ID, invalid static metadata, forbidden import, or oversized bundle fails `weft check` and workflow resolution before the run starts.
- Non-JSON or oversized props fail the `ctx.ui.render()` step before it can append a presentation.
- Blob persistence or durable append failures are ordinary run failures when the workflow awaits the presentation step.
- A browser load error, protocol mismatch, missing historical asset, or React rendering error falls back to the standard form or result without changing an already-recorded workflow value.

The host always exposes the generic form or raw output—not only after an error—so a misleading, inaccessible, or broken custom view cannot hide the durable source of truth.

## React runs in a constrained frame

Views are trusted application code from the workflow repository. The iframe is defense-in-depth isolation from Weft's DOM and authority; it is not a safe executor for hostile workflows or compromised dependencies.

The frame uses `sandbox="allow-scripts"` without `allow-same-origin`, so it receives an opaque origin. It is served only from an event-associated route such as:

```text
GET /api/runs/:ownerRunId/presentations/:presentationId/frame
```

The server folds that run's journal, resolves the bundle reference from the recorded presentation, verifies the content hash and envelope, and returns a server-owned HTML shell. A generic blob endpoint must never become an arbitrary HTML or JavaScript execution endpoint.

The frame response uses an HTTP Content Security Policy—not a meta-only substitute—with a starting policy equivalent to:

```text
default-src 'none';
script-src 'sha256-...';
style-src 'unsafe-inline';
img-src data: blob:;
connect-src 'none';
font-src 'none';
media-src 'none';
object-src 'none';
frame-src 'none';
worker-src 'none';
form-action 'none';
base-uri 'none';
sandbox allow-scripts;
frame-ancestors 'self';
```

The response also sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, `Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: no-store`. The parent iframe repeats the sandbox restriction and referrer policy.

This policy blocks parent DOM and storage access, daemon fetches, forms, subresources, workers, popups, and top-level navigation capabilities. It does not provide portable CPU or memory quotas, and a sandboxed document may still navigate its own frame to encode data in an external URL. The Workflow Manager renders only selected presentation surfaces, clamps their dimensions, and gives each one a **Disable** escape hatch. Weft does not claim hostile-code containment.

The browser compiler enforces the same trust boundary at build time. V1 allows only compiler-owned React packages, `@techery/weft-sdk/ui`, `@techery/weft-design-system`, and contained relative TypeScript or JavaScript modules. It rejects Node built-ins, path and symlink escapes, environment or secret-file imports, dynamic or remote imports, CSS and other unsupported assets, more than 32 views, and browser bundles over 1 MB. Use the design system's `WeftTheme` component instead of importing a stylesheet; it embeds the approved styles in the view. The frame CSP separately blocks network connections, workers, WebAssembly compilation, and `eval`-style execution at runtime. Source maps containing source content are not emitted.

## A parent-controlled message bridge

Because the iframe's opaque origin serializes as `null`, origin-string checks cannot authenticate it. The parent creates a `MessageChannel`, transfers one port after load, and then closes the global bootstrap listener. Messages on the port include a protocol version, presentation ID, and mount generation and are validated for mode, JSON serializability, and byte size. The answer endpoint independently verifies that the request is still pending.

Display views may report readiness and clamped dimensions. Input views may additionally stage a candidate answer. They receive no daemon API client, credentials, filesystem capability, workflow context, or final submission function. Resize messages are rate-limited, stale generations are ignored, and closing the frame closes the channel.

The Workflow Manager keeps host-owned chrome around every view:

- A visible “Workflow-provided view” label.
- The canonical question, risk, and artifact metadata.
- A candidate-answer preview and parent-owned submit control for input mode.
- A permanent standard form or raw output alongside the custom view.
- Clamped height, load timeout, React error handling, and a **Disable custom view** escape hatch.

Security-sensitive approvals, irreversible confirmations, and other risk-governed controls remain entirely native to Weft.

## How the implementation is split

The feature is implemented as five reviewable layers:

1. **Contracts and journal semantics.** UI token/types, JSON and size validation, the replayable UI step, human request keys and supersession, projections, and generic fallbacks.
2. **Dual compiler and asset catalog.** Static `.ui.tsx` discovery, a separate browser compiler and import policy, compiler-owned React dependencies, independent `defHash` and `buildHash`, and blob persistence.
3. **Read-only result views.** The event-associated frame route, strict security headers, host chrome, message channel, timeline association, and raw-output fallback.
4. **Human input views.** Candidate staging, server schema validation, host-owned confirmation, supersession behavior, and permanent standard-form parity.
5. **Entry-point propagation.** Inline manifests, child catalogs, MCP typings, registry caching, and explicit engine embedding contracts.

The separation is useful beyond code organization: the workflow engine never needs React, the browser never receives workflow authority, and a visual failure does not erase the generic representation of durable data.

## Repository implementation map

This feature could not be added only in the Workflow Manager. Its implementation crosses these package boundaries:

- `packages/sdk` adds the published `/ui` authoring subpath, opaque typed tokens, input/output type separation, and `ctx.ui.render()` declarations.
- `packages/gate` discovers `.ui.tsx` imports before the Node gate, runs the distinct browser compiler, produces `defHash`, `buildHash`, and the UI catalog, and applies browser-specific import and size policy.
- `packages/cli` teaches `weft check` to understand JSX and treats UI compilation errors as fatal rather than relying on its advisory TypeScript pass.
- `packages/core` adds the replayable UI step, presentation descriptors, JSON/blob props, human keys and supersession events, semantic hashes, projections, and child-runtime catalog resolution.
- `packages/host` and the registry propagate the catalog through path, named, inline, start, and resume flows instead of attaching metadata to a reconstructable `WorkflowDefinition` object.
- `packages/daemon` adds the event-associated frame route, verified asset envelope, strict response headers, and rejection of superseded answers.
- `apps/ui` adds host-owned frame chrome, `MessageChannel` lifecycle, candidate preview and confirmation, per-frame disable controls, generic fallbacks, and timeline presentations.
- Blob storage, export/import, and garbage collection treat every journaled UI asset and props reference as reachable run data.

This propagation is a launch requirement. Without it, a direct import may compile locally but lose its browser asset during registry loading, wrapping, child execution, or resume.

## Verification status

The repository's automated coverage now proves the core implementation contracts:

- A real file workflow imports `.ui.tsx`, compiles separate Node and browser graphs, records a presentation, and serves only its event-associated frame.
- A visual-only edit changes `buildHash` but not `defHash`; revision and props participate in presentation identity.
- Replay does not duplicate `ctx.ui.render()` occurrences, and UI steps refuse stale reuse-by-key salvage.
- A changed human interaction supersedes the old same-key request, and an old request ID cannot answer the run.
- The answer schema—not the component—accepts or rejects the staged candidate.
- Arbitrary presentation IDs cannot turn the blob store into an executable endpoint.
- The standard form and raw output remain visible beside custom UI.

Before treating the feature as hostile-code containment or completing a production browser rollout, Weft still needs an integration matrix in Chromium, Firefox, and WebKit covering DOM and storage isolation, blocked network/subresources/forms/popups, stale and forged messages, resize flooding, render failure, restart rendering, and the documented self-navigation limitation. Workflow views are trusted repository code; the iframe is defense in depth, not a general-purpose sandbox for hostile JavaScript.

With these contracts, custom React views fit Weft's architecture. They add expressive, workflow-owned presentation while preserving the journal as the source of truth, schemas as the authority over data, replay as an explicit semantic contract, and the host as the only authority that can advance a human decision.
