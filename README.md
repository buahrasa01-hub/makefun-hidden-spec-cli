# mend

[![Built with make.fun](https://img.shields.io/badge/make.fun-built%20with%20make.fun-202020)](https://make.fun)
[![make.fun competition entry](https://img.shields.io/badge/make.fun-competition%20entry-202020)](https://make.fun)
[![Open source on make.fun](https://img.shields.io/badge/make.fun-open%20source-202020)](https://make.fun)

One patch tool for unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON text edits.

Run `node main.ts` from the root of the tree. The patch is read from standard input by default; pass a patch file or
select a format with `--format=unified`, `--format=search-replace`, `--format=v4a`, or `--format=json`. Use `--check`
to preview changes and `--strict` to require exact line matches.
