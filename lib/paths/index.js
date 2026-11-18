"use strict";

// Project root of the checked-out repository. lib modules that need absolute
// paths (spill output, future caches) build them from here instead of from
// their own __dirname, so moving a lib module never silently changes where
// files land. See arch.md "lib/".
//
// lib/paths -> <root>

const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

module.exports = { PROJECT_ROOT };
