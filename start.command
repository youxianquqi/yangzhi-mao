#!/bin/sh
# Finder opens .command in Terminal; both UNIX entries share the same launcher.
exec /bin/sh "$(dirname "$0")/start.sh" "$@"
