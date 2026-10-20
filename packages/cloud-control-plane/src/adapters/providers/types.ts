export interface SandboxSpec {
  runId: string;
  taskId: string;
  taskStableId: string;
  generation: number;
  repoUrl: string;
  repoName: string;
  baseBranch: string;
  taskBranch: string;
  checkoutPath: string;
  controlPlaneUrl: string;
  attachToken: string;
}

export interface SandboxHandle {
  id: string;
  provider: string;
  meta: Record<string, unknown>;
}

export interface SandboxDriver {
  readonly id: string;
  readonly label: string;
  readonly capabilities: {
    pause: boolean;
    maxLifetimeSeconds: number;
    verified: boolean;
  };
  /** fake provider 不需要真实 checkout。 */
  readonly skipCheckout?: boolean;
  checkoutPath(taskStableId: string, repoName: string): string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  terminate(handle: SandboxHandle): Promise<void>;
}
