/** Compiled by `pnpm typecheck`, never run: the reader's SvelteKit and Vite pieces against the frameworks' own types. */

import { greatcmsWatch as viteWatch } from "@greatcms/reader/vite";
import { greatcmsHandle, greatcmsWatch } from "@greatcms/reader/sveltekit";
import { sequence, type Handle } from "@sveltejs/kit/hooks";
import { defineConfig, type Plugin } from "vite";

export const handle: Handle = greatcmsHandle;
export const composed: Handle = sequence(greatcmsHandle, ({ event, resolve }) => resolve(event));

export const plugins: Plugin[] = [greatcmsWatch(), greatcmsWatch({ root: "." }), viteWatch()];
export default defineConfig({ plugins: [greatcmsWatch(), viteWatch({ include: ["data"] })] });
