// Build-only helper: the OS must atomically refuse an existing destination directory.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) {
        fputs("Usage: rename-exclusive <staging-directory> <new-destination>\n", stderr);
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
        fprintf(stderr, "Atomic no-replace publication failed: %s\n", strerror(errno));
        return 1;
    }
    return 0;
}
