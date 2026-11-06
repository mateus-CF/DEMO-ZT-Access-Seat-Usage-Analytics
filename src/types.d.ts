declare module "cloudflare:workers" {
  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    env: Env;
    ctx: ExecutionContext;
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
  export interface WorkflowEvent<Params = unknown> { payload: Params; instanceId: string; timestamp: Date; schedule?: string; }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
    do<T>(name: string, config: unknown, callback: () => Promise<T> | T): Promise<T>;
  }
}
