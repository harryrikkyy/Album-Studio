# Contributing

Setup, the engine binaries, every test suite and the quality gates are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Before every commit, run the gates listed there;
the only test allowed to fail locally is the Poppler one when `pdftoppm` isn't installed.

Commits:

- One logical change per commit, with its tests.
- Subject in the imperative with a type prefix, e.g. `fix(backend): …`, `test: …`, `docs: …`.
- The body says why, with measurements where they matter.

Larger work starts from a design in `docs/superpowers/specs/` and a plan in
`docs/superpowers/plans/`.
