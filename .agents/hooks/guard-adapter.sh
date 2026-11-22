#!/usr/bin/env bash
# agy PreToolUse adapter: runs this repo's Claude Code guards for agy tool calls.
#
# agy sends {toolCall: {name, args}, cwd, ...} on stdin and reads {decision, reason}
# from stdout. The guards in .claude/hooks read Claude's payload shape and answer
# with a deny JSON (or, when broken, exit nonzero). This script translates both ways:
#   run_command            -> block-destructive.sh   (args.CommandLine)
#   write_file, edit_file  -> detect-secrets.sh      (args.Path plus the written text)
#
# It never fails open. Malformed input, an unsupported tool, a missing guard, a
# crashing guard or output it can't read all produce a deny that says what to fix.
# Always exits 0 so agy reads the decision from stdout.
set -uo pipefail

adapter_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
guards_dir="$adapter_dir/../../.claude/hooks"

# Argument names agy uses for the target file and for the text a write or edit adds.
PATH_KEYS=(Path AbsolutePath TargetFile)
CONTENT_KEYS=(Content CodeContent ReplacementContent NewString NewText)

# deny_agy <reason>: print agy's deny decision and stop. Works even when _lib.sh
# could not be loaded, since that is one of the cases it reports.
deny_agy() {
  if declare -F json_quote >/dev/null; then
    printf '{"decision":"deny","reason":%s}\n' "$(json_quote "$1")"
  else
    printf '{"decision":"deny","reason":"BLOCKED: .claude/hooks/_lib.sh not found, so the call is refused rather than run unguarded. Restore it."}\n'
  fi
  exit 0
}

[ -f "$guards_dir/_lib.sh" ] || deny_agy ""
# shellcheck source=../../.claude/hooks/_lib.sh
source "$guards_dir/_lib.sh"

# first_arg <input> <key>...: the first non-empty string among toolCall.args.<key>.
first_arg() {
  local input=$1 key value
  shift
  for key in "$@"; do
    value=$(hook_get "$input" "toolCall.args.$key" 2>/dev/null | head -n 1) || value=""
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

# all_args <input> <key>...: every string among toolCall.args.<key>, joined.
all_args() {
  local input=$1 key
  shift
  for key in "$@"; do
    hook_get "$input" "toolCall.args.$key" 2>/dev/null || true
  done
}

# claude_payload <tool> <input>: the Claude-shape payload for <tool>, or return 1
# when the call is missing what the guard needs.
claude_payload() {
  local tool=$1 input=$2 cwd command file_path content
  cwd=$(hook_get "$input" cwd 2>/dev/null | head -n 1) || cwd=""
  case "$tool" in
  run_command)
    command=$(first_arg "$input" CommandLine) || return 1
    printf '{"tool_name":"Bash","cwd":%s,"tool_input":{"command":%s}}' \
      "$(json_quote "$cwd")" "$(json_quote "$command")"
    ;;
  write_file | edit_file)
    file_path=$(first_arg "$input" "${PATH_KEYS[@]}") || return 1
    content=$(all_args "$input" "${CONTENT_KEYS[@]}")
    printf '{"tool_name":"Write","cwd":%s,"tool_input":{"file_path":%s,"content":%s}}' \
      "$(json_quote "$cwd")" "$(json_quote "$file_path")" "$(json_quote "$content")"
    ;;
  esac
}

# guard_for <tool>: the guard script that covers <tool>.
guard_for() {
  case "$1" in
  run_command) printf '%s' "$guards_dir/block-destructive.sh" ;;
  write_file | edit_file) printf '%s' "$guards_dir/detect-secrets.sh" ;;
  esac
}

input=$(cat)
tool=$(hook_get "$input" toolCall.name 2>/dev/null | head -n 1) || tool=""
[ -n "$tool" ] || deny_agy "BLOCKED: the hook input has no toolCall.name (malformed JSON?), so the call is refused. Check the agy hook payload."

guard=$(guard_for "$tool")
[ -n "$guard" ] || deny_agy "BLOCKED: the guard adapter has no guard for tool '$tool', so the call is refused. Limit the matchers in .agents/hooks.json to run_command, write_file and edit_file."
[ -f "$guard" ] || deny_agy "BLOCKED: .claude/hooks/$(basename "$guard") not found, so the call is refused rather than run unguarded. Restore the guard script."

payload=$(claude_payload "$tool" "$input") ||
  deny_agy "BLOCKED: the $tool call lacks the argument the guard reads (CommandLine, or Path for a write), so it is refused. Check the agy tool arguments."

stderr_file=$(mktemp) || deny_agy "BLOCKED: the guard adapter could not create a temp file, so the call is refused."
trap 'rm -f "$stderr_file"' EXIT
output=$(printf '%s' "$payload" | bash "$guard" 2>"$stderr_file")
status=$?
guard_stderr=$(head -c 2000 "$stderr_file")

if [ "$status" -ne 0 ]; then
  deny_agy "BLOCKED: ${guard_stderr:-the guard exited with status $status}"
fi
if [ -z "$output" ]; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

decision=$(hook_get "$output" hookSpecificOutput.permissionDecision 2>/dev/null | head -n 1) || decision=""
if [ "$decision" = "deny" ]; then
  reason=$(hook_get "$output" hookSpecificOutput.permissionDecisionReason 2>/dev/null) || reason=""
  deny_agy "${reason:-BLOCKED by $(basename "$guard")}"
fi
deny_agy "BLOCKED: $(basename "$guard") printed output the adapter does not understand, so the call is refused."
