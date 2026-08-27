import { z } from "@techery/weft-sdk";

export const Service = z.enum([
  "api",
  "web",
  "worker",
  "billing",
  "search",
  "notifications",
  "analytics",
  "identity",
]);
export type Service = z.infer<typeof Service>;

export const DeploymentRisk = z.enum(["low", "medium", "high", "critical"]);
export type DeploymentRisk = z.infer<typeof DeploymentRisk>;

export const DeploymentStrategy = z.enum(["rolling", "canary", "blue-green"]);
export type DeploymentStrategy = z.infer<typeof DeploymentStrategy>;

export const DeploymentWindow = z.enum(["now", "maintenance-window", "scheduled"]);
export type DeploymentWindow = z.infer<typeof DeploymentWindow>;

export const DeploymentInput = z.object({
  environment: z.enum(["staging", "production"]).default("staging"),
  releaseName: z.string().min(1).max(80).default("August reliability release"),
  version: z.string().min(1).max(40).default("2026.08.26-rc.3"),
  requestedBy: z.string().min(1).max(120).default("release-bot@weft.local"),
  risk: DeploymentRisk.default("high"),
  window: DeploymentWindow.default("maintenance-window"),
  services: z
    .array(Service)
    .min(1)
    .default(["api", "web", "worker", "billing", "search", "notifications", "analytics", "identity"]),
});

export const DeploymentDecision = z.object({
  intent: z.enum(["approve", "partial", "reject"]),
  approvedServices: z.array(Service),
  strategy: DeploymentStrategy,
  trafficPercent: z.number().int().min(1).max(100),
  monitorMinutes: z.number().int().min(5).max(120),
  rollbackOnError: z.boolean(),
  runSmokeTests: z.boolean(),
  acknowledgedRisk: z.boolean(),
  changeTicket: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
});
export type DeploymentDecision = z.infer<typeof DeploymentDecision>;

export const DeploymentOutput = z.object({
  environment: z.enum(["staging", "production"]),
  releaseName: z.string(),
  version: z.string(),
  risk: DeploymentRisk,
  window: DeploymentWindow,
  decision: z.enum(["approved", "partial", "rejected"]),
  approvedServices: z.array(Service),
  deferredServices: z.array(Service),
  strategy: DeploymentStrategy,
  trafficPercent: z.number(),
  monitorMinutes: z.number(),
  rollbackOnError: z.boolean(),
  runSmokeTests: z.boolean(),
  changeTicket: z.string().optional(),
  note: z.string().optional(),
  warnings: z.array(z.string()),
});
