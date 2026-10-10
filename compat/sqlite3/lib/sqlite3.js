// Compatibility shim for the old updater's `require('sqlite3')` probe.
//
// Before the node:sqlite migration, the updater validated each candidate
// version by running `node -e "require('sqlite3')"` inside the candidate
// directory. That probe must exit 0 for the old updater to write `current`
// and activate the new version. Without this shim, the old updater gets
// MODULE_NOT_FOUND and the new code never runs.
//
// This file is intentionally empty: it only needs to be resolvable.
// Once every deployed updater runs the new `require('node:sqlite')` probe,
// this shim can be removed.
module.exports = {};
