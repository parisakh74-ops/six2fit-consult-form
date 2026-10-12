export class StoreError extends Error {
  constructor(
    public readonly kind: "UNAVAILABLE" | "CORRUPT" | "NOT_CONFIGURED" | "REJECTED" | "TOO_LARGE",
    message: string,
    /** Safe machine code (never contains answers, tokens or credentials). */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
