#!/usr/bin/env bash
# Adapt native patch writes through the shared parser and secret guard.
set -euo pipefail
hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source "$hook_dir/../../.claude/hooks/_lib.sh"
check_patch "$(cat)" "$hook_dir/../../.claude/hooks/detect-secrets.sh"
