import { z } from "@techery/weft-sdk";

export const Service = z.enum(["api", "web", "worker", "billing"]);
export type Service = z.infer<typeof Service>;

export const DeploymentInput = z.object({
  environment: z.enum(["staging", "production"]).default("staging"),
  services: z.array(Service).min(1).default(["api", "web", "worker"]),
});

export const DeploymentDecision = z.object({
  approvedServices: z.array(Service).min(1),
  note: z.string().max(500).optional(),
});
export type DeploymentDecision = z.infer<typeof DeploymentDecision>;

export const DeploymentOutput = z.object({
  environment: z.enum(["staging", "production"]),
  approvedServices: z.array(Service),
  deferredServices: z.array(Service),
  note: z.string().optional(),
});
