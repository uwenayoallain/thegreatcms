/** Every error in the standard names three things: where it happened, what is wrong. */

export interface SpecIssueInit {
  /** Stable machine code, e.g. `unknown_field_type`. */
  code: string;
  /** File the problem lives in, repo-relative: `.cms/schema.yaml`. */
  file?: string;
  /** Dotted path inside that file: `regions.home.hero.fields.heading.max`. */
  path?: string;
  /** One line: what is wrong. */
  message: string;
  /** One line: what to do about it. */
  fix?: string;
}

export class SpecIssue {
  readonly code: string;
  readonly file: string | undefined;
  readonly path: string | undefined;
  readonly message: string;
  readonly fix: string | undefined;

  constructor(init: SpecIssueInit) {
    this.code = init.code;
    this.file = init.file;
    this.path = init.path;
    this.message = init.message;
    this.fix = init.fix;
  }

  toString(): string {
    const where = [this.file, this.path].filter(Boolean).join(" › ");
    const head = where ? `${where}: ${this.message}` : this.message;
    return this.fix ? `${head}\n  fix: ${this.fix}` : head;
  }
}

export class SpecError extends Error {
  readonly issues: readonly SpecIssue[];

  constructor(summary: string, issues: readonly SpecIssue[]) {
    const body = issues.map((i) => `  - ${i.toString().replace(/\n/g, "\n  ")}`).join("\n");
    super(issues.length > 0 ? `${summary}\n${body}` : summary);
    this.name = "SpecError";
    this.issues = issues;
  }
}

/** Collects issues so a bad file reports every problem at once, not one per run. */
export class IssueBag {
  private readonly issues: SpecIssue[] = [];

  constructor(private readonly file?: string) {}

  add(init: Omit<SpecIssueInit, "file"> & { file?: string }): void {
    this.issues.push(new SpecIssue({ file: this.file, ...init }));
  }

  get length(): number {
    return this.issues.length;
  }

  list(): readonly SpecIssue[] {
    return this.issues;
  }

  throwIfAny(summary: string): void {
    if (this.issues.length > 0) throw new SpecError(summary, this.issues);
  }
}

/** Runs `work`; nesting deep enough to exhaust the stack becomes an error that says so. */
export function boundedDepth<T>(file: string | undefined, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new SpecError("Content is nested too deeply to read", [
      new SpecIssue({
        code: "too_deep",
        file,
        message: "The document nests thousands of levels deep.",
        fix: "Flatten it: no real page nests blocks or groups this far.",
      }),
    ]);
  }
}
