#!/usr/bin/env python3
"""PreToolUse hook: Block git config commands.

The charter mandates per-commit `-c` flags — never modify global or repo-level
git config. This hook blocks ALL `git config` commands.

Exit codes:
  0 — allow (not a git config command)
  2 — block (git config detected)
"""

import json
import re
import sys


def main() -> None:
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    command = input_data.get("tool_input", {}).get("command", "")

    # Match `git config` as a standalone command (not just a substring in another word)
    if not re.search(r"\bgit\s+config\b", command):
        sys.exit(0)

    result = {
        "decision": "block",
        "reason": (
            "BLOCKED: `git config` is prohibited by the charter (§ Commit Identity). "
            "Never modify global or repo-level git config. "
            "Use per-commit `-c` flags instead:\n"
            '  git -c user.name="Name" -c user.email="email@example.com" commit -m "..."\n'
            "See .claude/team/charter.md § Commit Identity for the full identity table."
        ),
    }
    print(json.dumps(result))
    sys.exit(2)


if __name__ == "__main__":
    main()
