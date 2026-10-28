# Archived quality evidence

On 2026-10-28, raw evidence moved out of git to keep the repository small:

- every `.log` file under `docs/quality/`
- evidence files under `docs/` larger than 100 KB
- the untracked evidence of `2026-10-16-iteration-10/` (its `README.md` stays here)
- `native/scripts/engine/architecture-publication-20261016.bundle`

They live in `/Volumes/Harry/works/albumStudio-quality-archive/`, each at its original
repository-relative path. Tracked files also remain in git history (`205090a` is the last commit
that holds them), but 42 of the files were never tracked and have no other copy: back the archive
up and don't delete it. To verify the archive:

    cd /Volumes/Harry/works/albumStudio-quality-archive
    shasum -a 256 -c archive-manifest.sha256

[`archive-manifest.sha256`](archive-manifest.sha256) lists every moved file with its checksum.
New raw logs are ignored by git; keep them in the archive.
