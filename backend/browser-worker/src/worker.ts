export const workerCapabilities = [
  "render-page",
  "capture-dom",
  "capture-screenshot",
] as const;

export type WorkerCapability = (typeof workerCapabilities)[number];
