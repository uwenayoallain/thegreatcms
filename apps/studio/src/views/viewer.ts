/** Who is signed in, for the length of one request, so the layout can say so without every page passing it along. */

import { AsyncLocalStorage } from "node:async_hooks";

export interface Viewer {
  /** What commits and the publish log record. */
  name: string;
  /** An owner manages sites and people: the studio's password, or a GitHub account named as one. */
  owner: boolean;
  /** An editor with a password here. Never shown to anyone but the owner. */
  email?: string;
  /** Someone who signed in with GitHub, as GitHub named them at that moment. */
  github?: {
    id: number;
    login: string;
    /** The address GitHub gives every account for commits; their own is never asked for. */
    email: string;
  };
}

const current = new AsyncLocalStorage<Viewer>();

export const withViewer = <T>(viewer: Viewer, run: () => T): T => current.run(viewer, run);

export const viewer = (): Viewer | undefined => current.getStore();
