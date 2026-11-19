/** A failure with a message meant for the user, printed without a stack trace. */
export class T3pError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "T3pError";
  }
}

/** Thrown when a rename fails with EBUSY/EPERM: T3 Code (or a lock) holds the files. */
export class AppRunningError extends T3pError {
  constructor(message = "T3 Code appears to be running and is holding its files. Close T3 Code and retry.") {
    super(message);
    this.name = "AppRunningError";
  }
}

const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export function isBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && BUSY_CODES.has(code);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
