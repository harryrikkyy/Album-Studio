# Iteration 4 evidence

Start with `verification.json`, the root quality log and scorecard. This is a source checkpoint,
not certification of an installed application, arbitrary files, customer licences or lab prints.

- `node-gate-final.log`: 273 shared + 515 backend + 33 interface = 821 passed, no skips.
- `coverage-final.log`: separate 788-test shared/backend run. Aggregate includes test files;
  use source-file rows rather than presenting the aggregate as product coverage.
- `pipeline-pilot-final.json`, `pipeline-metrics.json`, `pipeline-pilot-final.log`: completed
  distinct-12-MP synthetic pilot with source hashes, measurements, all output/reorder/PDF checks
  and explicit limitations. Full generated inputs/outputs remain in the named ignored local
  benchmark folder; they are not in Git. `pipeline-pilot-before.*` retains the first failed
  Poppler raster-size assumption. Final code verifies physical page boxes and requests both
  raster dimensions explicitly. Pixel tolerances were unchanged.
- `shared-output-diagnostic.*`: two disposable independent job reservations share an output
  namespace. The script never renders or publishes artifacts; collision does not prove overwrite.
  Run from the repository root with `ALBUM_STUDIO_RENAME_CLI` pointing to the current helper.
  `shared-output-missing-helper.log` is an initial setup failure, not a product regression.
- `review-and-limits.json`: actual provider execution limit and unfinished independent review,
  external inputs and local checks. Required final independent integration review is incomplete.
- `*-before.log`: retained fail-first diagnostics or rejected/intermediate runs, not current
  passing evidence. Pinned baseline loaders reproduce the earlier job/location source.
- `hfs-observation-after.log`: intermediate watcher-based attempt. It was later rejected;
  `hfs-notification-rejected.log` records missed mutations and false alarms. The final code uses
  two-pass content verification and read-only snapshots; `frozen-hfs-focused.log` and the final
  gate/coverage validate that version. No watcher is retained in the final implementation.
- `*-before-score-version3.log`: passing earlier 820/787 runs, immediately before the final
  scoring-cache invalidation regression. They are historical, not the final source result.
- Scoped logs document specific boundaries. Only the final full gate/coverage cover the final
  integrated production modules. Formatting is a fresh native workspace check; full native
  workspace tests/Clippy/layering/corpus, hosted CI and a new root package remain unverified.

All 90 criterion names and weights are unchanged. Only performance criteria 4, 5 and 9 gain
five partial points each from the pilot, raising performance to 3.0/10. No new criterion is
complete, no category is certified and the mission remains active. Preserve user audit/invoice
folders, engine `.DS_Store` files and existing bundles.
