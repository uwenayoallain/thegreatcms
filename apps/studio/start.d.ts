/** The studio's programmatic entry; the server itself is one bundled file with no types of its own. */

/** The oldest Node.js the studio runs on. */
export declare const MIN_NODE: string;

/** Whether a host can only be reached from this machine. */
export declare function isLoopback(host: string): boolean;

export interface DeclaredSite {
  id: string;
  path: string;
  name: string;
  devUrl: string;
  probeUrl: string;
  pushAfterPublish: boolean;
  deployRoot: string;
}

export interface StartOptions {
  password: string;
  secret?: string;
  databaseFile: string;
  port: number;
  hostname?: string;
  sites?: DeclaredSite[];
  trustProxy?: boolean | "cloudflare";
  publicUrl?: string;
  cookieDomain?: string;
  sitesRoot?: string;
  previewUrl?: string;
  previewsFile?: string;
  previewProbe?: string;
  timeZone?: string;
}

export interface RunningStudio {
  port: number;
  declared: string[];
  close(): Promise<void>;
}

/** Opens the database, connects the declared sites and listens. Rejects when the port is taken. */
export declare function start(options: StartOptions): Promise<RunningStudio>;

export interface LocalOptions {
  /** The site's folder: the one holding `.cms/schema.yaml`. */
  root: string;
  name: string;
  /** Where the database and the session secret go. */
  stateDir: string;
  port: number;
  /** `127.0.0.1` unless told otherwise. Anything that is not loopback needs `password`. */
  host?: string;
  devUrl?: string;
  password?: string;
}

export interface RunningLocalStudio extends RunningStudio {
  url: string;
  /** Signs one browser in, once; absent when a password guards the studio instead. */
  signInUrl?: string;
  siteId: string;
}

/** One folder on loopback, signed in by a one-time link: what `greatcms studio` runs. */
export declare function startLocal(options: LocalOptions): Promise<RunningLocalStudio>;
