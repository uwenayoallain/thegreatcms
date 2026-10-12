#!/usr/bin/env node
import { previewMain } from "../dist/index.js";

process.exitCode = await previewMain(process.argv.slice(2), process.env);
