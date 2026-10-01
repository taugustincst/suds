#!/bin/bash
# Prints each argument as a command ("$ <command>") and runs it with bash, stderr with stdout, in order.
for c in "$@"; do printf '$ %s\n' "$c"; bash -c "$c" 2>&1; done
