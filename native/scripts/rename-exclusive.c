// The OS must atomically refuse an existing file or directory. Built for package/setup
// publication and bundled for recoverable runtime capture of customer delivery files.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#ifndef ALBUM_STUDIO_RENAME_SHA
#define ALBUM_STUDIO_RENAME_SHA "build-only"
#endif

static const char *error_code(int value) {
    switch (value) {
        case EEXIST: return "EEXIST";
        case ENOTEMPTY: return "ENOTEMPTY";
        case ENOENT: return "ENOENT";
        case EXDEV: return "EXDEV";
        case EACCES: return "EACCES";
        case EPERM: return "EPERM";
        case EINVAL: return "EINVAL";
        case ENOSPC: return "ENOSPC";
        case ENOTSUP: return "ENOTSUP";
        default: return "EIO";
    }
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts("album-studio-rename-exclusive " ALBUM_STUDIO_RENAME_SHA);
        return 0;
    }
    if (argc != 3) {
        fputs("Usage: rename-exclusive <source> <new-destination>\n", stderr);
        return 2;
    }
    int result;
#if defined(__APPLE__)
    result = renamex_np(argv[1], argv[2], RENAME_EXCL);
#elif defined(__linux__)
    result = renameat2(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE);
#else
    errno = ENOTSUP;
    result = -1;
#endif
    if (result != 0) {
        fprintf(stderr, "%s: Atomic no-replace publication failed: %s\n", error_code(errno), strerror(errno));
        return 1;
    }
    return 0;
}
