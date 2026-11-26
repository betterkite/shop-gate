/* A missing container passwd entry is not an authorization identity.
 * Resolve ONLY this unprivileged process UID for ephemeral initdb children.
 * Never edits /etc/passwd, changes UID or grants database capabilities.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static struct passwd temporary_user;
static struct passwd *fallback_user(void) {
    if (geteuid() == 0) return NULL;
    temporary_user.pw_name = "shopgate-verifier";
    temporary_user.pw_passwd = "x";
    temporary_user.pw_uid = geteuid();
    temporary_user.pw_gid = getegid();
    temporary_user.pw_gecos = "Ephemeral verifier";
    temporary_user.pw_dir = getenv("HOME");
    temporary_user.pw_shell = "/bin/false";
    return &temporary_user;
}
struct passwd *getpwuid(uid_t uid) {
    struct passwd *(*original)(uid_t) = dlsym(RTLD_NEXT, "getpwuid");
    struct passwd *result = original(uid);
    return result || uid != geteuid() ? result : fallback_user();
}
struct passwd *getpwnam(const char *name) {
    struct passwd *(*original)(const char *) = dlsym(RTLD_NEXT, "getpwnam");
    struct passwd *result = original(name);
    return result || strcmp(name, "shopgate-verifier") != 0 ? result : fallback_user();
}
