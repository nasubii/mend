# mend — one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nasubii/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nasubii/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

An entry for make.fun's [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
`main.ts` is mend, the command-line tool the kit's SPEC.md specifies. It reads a patch in
any of the four formats AI models write — unified diff, SEARCH/REPLACE blocks, V4A and
JSON edits — finds the lines each edit names at the first of three matching tiers (exact,
trailing-whitespace-insensitive, fully trimmed, with re-indentation at the loosest tier),
and writes every change or none, printing what it changed or why it failed.

On the kit's 100 public practice checks it scores the full 1,000.
