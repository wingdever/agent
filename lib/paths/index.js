"use strict";

// Project root of the checked-out repository. lib modules that need absolute
// paths (spill output, future caches) build them from here instead of from
// their own __dirname, so moving a lib module never silently changes where
// files land. See arch.md "lib/".
//
// lib/paths -> <root>

import path from "path";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));


const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const __exports = { PROJECT_ROOT };
export { PROJECT_ROOT };
export default __exports;
