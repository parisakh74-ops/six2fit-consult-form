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

  /**
   * True only when the failure proves that nothing was written to the CRM (no request was sent, or the CRM
   * definitively refused it). Anything else after a write was attempted is an UNKNOWN outcome.
   */
  public notWritten = false;
}
