/** Light, dark, or whatever the system says: chosen once, kept in a cookie, read for each request. */

import { AsyncLocalStorage } from "node:async_hooks";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "greatcms_theme";

const current = new AsyncLocalStorage<Theme>();

export const withTheme = <T>(theme: Theme, run: () => T): T => current.run(theme, run);

export const theme = (): Theme => current.getStore() ?? "system";

/** The theme a request's cookies name, and the system's when they name none, or nonsense. */
export function themeOf(cookies: string | undefined): Theme {
  const value = /(?:^|;\s*)greatcms_theme=([a-z]+)/.exec(cookies ?? "")?.[1];
  return (THEMES as readonly string[]).includes(value ?? "") ? (value as Theme) : "system";
}
