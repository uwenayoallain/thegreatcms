/** What the shell shows alike on every screen, read once per request: the panes' widths and the inbox count. */

import { AsyncLocalStorage } from "node:async_hooks";

export interface Chrome {
  /** The width the sidebar was dragged to, in pixels; the stylesheet's default when unset. */
  sidebar?: number;
  /** The width the live preview was dragged to, in pixels. */
  live?: number;
  unread?: () => number;
  /** One project, on the machine of whoever started it: nothing about other sites or other people is offered. */
  local?: boolean;
}

const current = new AsyncLocalStorage<Chrome>();

export const withChrome = <T>(chrome: Chrome, run: () => T): T => current.run(chrome, run);

export const chrome = (): Chrome => current.getStore() ?? {};

/** The widths a request's cookies name, each only when it is one its handle could have set. */
export function panesOf(cookies: string | undefined): Pick<Chrome, "sidebar" | "live"> {
  const width = (name: string, min: number, max: number) => {
    const value = Number(
      new RegExp(`(?:^|;\\s*)${name}=(\\d{1,4})(?:;|$)`).exec(cookies ?? "")?.[1],
    );
    return value >= min && value <= max ? value : undefined;
  };
  return { sidebar: width("greatcms_sidebar", 176, 480), live: width("greatcms_live", 320, 4000) };
}
