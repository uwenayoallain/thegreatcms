/** @greatcms/cli: the local half of the workflow. */

export { createUi, wantsColour, type Ui } from "./ui.js";
export { parseFlags, type Flags } from "./commands.js";
export { VERSION } from "./version.js";
export { run, type RunOptions } from "./run.js";
export {
  loadConfig,
  loadSchema,
  nodeCheckFiles,
  nodeFiles,
  nodeGit,
  type InitDeps,
} from "./handlers.js";
