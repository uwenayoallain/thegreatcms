/** Who is signed in, for the length of one request, so the layout can say so without every page passing it along. */

import { AsyncLocalStorage } from "node:async_hooks";

export interface Viewer {
  /** What commits and the publish log record. */
  name: string;
  /** The owner signs in with the studio's password and manages sites and people. */
  owner: boolean;
  email?: string;
}

const current = new AsyncLocalStorage<Viewer>();

export const withViewer = <T>(viewer: Viewer, run: () => T): T => current.run(viewer, run);

export const viewer = (): Viewer | undefined => current.getStore();
