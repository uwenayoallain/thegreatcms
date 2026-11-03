/** What the CLI needs from the outside world, and the error it reports with. */

/** A failure a person can act on, printed without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? `${message}\n  fix: ${fix}` : message);
    this.name = "CliError";
  }
}

export interface FilePort {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface GitPort {
  run(args: string[]): Promise<string>;
}

/** The command was called wrongly: an unknown option, a missing value, an extra argument. Exits 2. */
export class UsageError extends CliError {
  constructor(message: string, fix?: string) {
    super(message, fix);
    this.name = "UsageError";
  }
}
