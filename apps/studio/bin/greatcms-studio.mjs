#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `The GreatCMS studio needs Node.js 22.13 or newer, and this is ${process.version}.\n  fix: install a current Node.js (nodejs.org), then run this again.\n`,
  );
  process.exit(1);
}

// The server, configured from the environment: STUDIO_PASSWORD, STUDIO_DB, PORT, STUDIO_SITES.
await import("../dist/main.js");
