# Todo — Phase 0: Verification foundation & CI

> Tracks the current phase only. When all are done + checkpoint passes, we write
> the Phase 1 list. Legend: [x] done · [~] needs owner input · [ ] pending.

## Tasks

- [x] **Add coverage script**
  - Acceptance: `npm run test:coverage` runs the suite + prints a coverage report.
  - Verify: command exits 0, shows a coverage summary. ✅ 70/70, 75.9% line baseline.
  - Files: `package.json`

- [x] **Add GitHub Actions CI**
  - Acceptance: workflow runs lint + typecheck + test:coverage on push/PR to `main`.
  - Verify: green run once pushed to GitHub (`harryrikkyy/Album-Studio`).
  - Files: `.github/workflows/ci.yml`

- [x] **Developer/verification guide**
  - Acceptance: a cold clone can install, run, and knows the gates + smoke-test.
  - Files: `docs/DEVELOPMENT.md`

- [ ] **Push Phase 0 to GitHub to activate CI**
  - Acceptance: CI shows a green run on GitHub.
  - Verify: Actions tab green.
  - Blocked on: owner OK to `git push` (repo is currently local-ahead of origin).

- [~] **Commit the sample project as an E2E fixture**
  - Acceptance: a sanitized `.json` (no private paths/emails) lives in
    `e2e/fixtures/` and loads in the app.
  - Verify: app opens it without error.
  - Blocked on: **owner to provide the saved project `.json`.**

- [~] **Rotate the leaked credentials (owner action)**
  - Acceptance: Google OAuth client secret + `LICENSE_SECRET_KEY` rotated; old
    `dist/` build (which contains the old secrets) deleted.
  - Verify: new secret in local `.env` only; app still signs in.
  - Blocked on: **owner** (Cloud Console + Firebase).

## Phase 0 checkpoint (exit criteria)

- [ ] CI green on GitHub for a no-op change.
- [ ] `docs/DEVELOPMENT.md` gets a cold start running against the sample fixture.
- [ ] Leaked secret rotated; compromised build removed.

When these pass → proceed to Phase 1 (safety-net tests), write `tasks/todo.md`
for it.
