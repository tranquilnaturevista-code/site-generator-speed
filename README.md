# Site Generator Speed — Build a static site faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/tranquilnaturevista-code/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/tranquilnaturevista-code/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` answers
exactly as makefun-site does on every input — the same output tree (each
page's `index.html`, the index and tag pages, `build-report.txt` and each
static file), byte for byte — in about half the CPU time.

Entry for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122)
"Build a static site faster" ($100, 10 places × $10). Places go by CPU time
on the scored set, least first, among entries whose answers match
makefun-site 1.0.0 on every case — and only entries faster than the house
baseline qualify for a reward.

## How it works

`run(input)` re-implements makefun-site's own rules from its specification
(strict front matter, its own Markdown subset, its own template dialect,
its own slug rule and report), in its own code:

- **Markdown in one fused pass** over the lines — no token objects, no
  second walk. Inline markup renders over index ranges into a shared
  output array, so nested strong/emphasis never copies substrings, and
  plain runs jump to the next significant character with native `indexOf`
  scans.
- **Templates compiled to JavaScript** — each parsed template is compiled
  once per build into a render function (literals via `JSON.stringify`),
  so rendering does the same lookups and writes as the interpreter
  without a dispatch per operation. A template that does not compile
  falls back to the interpreter, which is kept alongside.
- **Small wins that add up**: slugs cached per build, words counted by a
  manual scan, HTML escaping on whole plain runs, each post's card
  computed once and reused by its page, no work kept from one case to
  the next.

## Local test

Against the kit's practice set (3 cases, 250–480 Markdown sources each),
checked byte-for-byte against the kit's `practice/reference/expected.json`:

- **3 / 3 cases identical** to makefun-site 1.0.0.
- **~282 ms** for the 3 cases vs **~501 ms** for the house baseline in
  the same process (median of 12 alternating runs) — **~1.77× faster**.
- 300 mutation-fuzz iterations plus 22 targeted edge cases (recursive
  includes, `constructor` as a template name, loop shadowing, unclosed
  tags, bad paths, CRLF/lone-CR sources, Unicode slugs, all-draft sites,
  no posts) all match the reference exactly.

`main.ts` is the harness driver: it reads `/input/cases.json`, answers
each case alone with `run()`, and writes `/output/answers.json`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in outside a container).
