import type { Service } from "./schemas.ts";

export type ServiceHealth = "ready" | "degraded" | "blocked" | "queued";

export const serviceCatalog: Record<
  Service,
  {
    label: string;
    description: string;
    owner: string;
    health: ServiceHealth;
    change: string;
    dependencies: string[];
  }
> = {
  api: {
    label: "Public API",
    description: "Request routing, rate limits, and external contracts.",
    owner: "Core platform",
    health: "ready",
    change: "+184 / −63",
    dependencies: ["identity", "billing"],
  },
  web: {
    label: "Web application",
    description: "Customer shell, cached assets, and edge rendering.",
    owner: "Product web",
    health: "ready",
    change: "+92 / −41",
    dependencies: ["api"],
  },
  worker: {
    label: "Async workers",
    description: "Queues, scheduled jobs, and retry processing.",
    owner: "Core platform",
    health: "degraded",
    change: "+311 / −108",
    dependencies: ["api", "notifications"],
  },
  billing: {
    label: "Billing",
    description: "Invoices, subscriptions, and payment webhooks.",
    owner: "Revenue systems",
    health: "blocked",
    change: "+48 / −12",
    dependencies: ["api", "identity"],
  },
  search: {
    label: "Search index",
    description: "Index ingestion, ranking, and query suggestions.",
    owner: "Discovery",
    health: "queued",
    change: "+1,204 / −388",
    dependencies: ["api", "worker"],
  },
  notifications: {
    label: "Notifications",
    description: "Transactional email, push, and delivery receipts.",
    owner: "Engagement",
    health: "ready",
    change: "+74 / −29",
    dependencies: ["worker"],
  },
  analytics: {
    label: "Analytics pipeline",
    description: "Event collection and warehouse synchronization.",
    owner: "Data platform",
    health: "degraded",
    change: "+2,841 / −901",
    dependencies: ["worker", "api"],
  },
  identity: {
    label: "Identity",
    description: "Sessions, permissions, and token issuance.",
    owner: "Security",
    health: "blocked",
    change: "+39 / −17",
    dependencies: [],
  },
};

export const healthColors: Record<ServiceHealth, { background: string; foreground: string }> = {
  ready: { background: "var(--color-accent-2-200)", foreground: "var(--color-accent-2-800)" },
  degraded: { background: "#f5e9bf", foreground: "#725715" },
  blocked: { background: "var(--color-danger-bg)", foreground: "var(--color-danger)" },
  queued: { background: "var(--color-neutral-200)", foreground: "var(--color-neutral-700)" },
};
