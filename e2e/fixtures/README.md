# E2E fixtures

Test data for end-to-end and manual smoke-tests.

## `sample-project.json`
A real 15-page engagement album saved by the app, **sanitized** for the repo:
all `/Volumes/...` paths were rewritten to `/fixtures/...` and the client name
removed. No private paths, names, or credentials remain.

The file paths inside are placeholders, so this fixture is for **structural**
tests (load/parse a project, drive state, undo/redo, hashing). Tests that render
real pixels through Photoshop use a live project on the developer's machine, not
this fixture.
