/** Stopping without cutting a publish in half: finish what is in flight, then close. */

export interface Stoppable {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface ShutdownOptions {
  server: Stoppable;
  /** Resolves when no publish, push or branch change is in flight. */
  settled: () => Promise<void>;
  /** Closes what must be closed last, such as the database. */
  close: () => void;
  /** How long in-flight work gets; a container is killed ten seconds after it is asked to stop. */
  deadlineMs?: number;
  log?: (line: string) => void;
}

/**
 * Stops taking requests, lets the ones being answered finish along with any publish they
 * started, and closes the database after them. Past the deadline it closes anyway and says so.
 * Resolves with the exit code.
 */
export async function shutDown(options: ShutdownOptions): Promise<number> {
  const { server, settled, close, deadlineMs = 8000, log = () => {} } = options;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Connections waiting for a next request would hold the server open until they time out.
  server.closeIdleConnections?.();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  // Requests first: one of them may be about to start a publish.
  const finished = closed.then(settled).then(() => "done" as const);
  const outcome = await Promise.race([finished, deadline]);
  clearTimeout(timer);
  if (outcome === "late") {
    log("stopping with work still in flight: it did not finish in time");
    server.closeAllConnections?.();
  }
  close();
  return outcome === "late" ? 1 : 0;
}

/** Keeps the server up through a stray rejection, and says what it was. */
export function describeFailure(reason: unknown): string {
  return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
}
