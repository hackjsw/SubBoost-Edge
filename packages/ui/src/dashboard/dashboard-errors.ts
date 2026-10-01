// Adapters throw this so the dashboard can tell an expired session apart from
// a transient failure and offer a login action instead of a dead-end toast.
export class DashboardApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export function isUnauthorizedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401;
}
