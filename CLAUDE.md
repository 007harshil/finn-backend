## graphify (MANDATORY)

This project has a knowledge graph at `graphify-out/`.

**Hard rules — never break these:**

1. **NEVER** read, open, or cat these files:
   - `graphify-out/graph.json`
   - `graphify-out/GRAPH_REPORT.md`
   - any file inside `graphify-out/`

2. For **any** codebase question (how something works, where something is used, relationships, architecture, flow, etc.):
   - First run: `graphify query "<question>"`
   - For specific symbols/classes/functions: `graphify explain "<Name>"`
   - For connection between two things: `graphify path "<A>" "<B>"`

3. Only fall back to Grep / Read / Glob **after** a graph query, and only if the query result is insufficient.

4. Prefer targeted commands:
   - User says a class/function name → use `graphify explain "ClassName"`
   - Do **not** run broad open-ended queries when a specific name is given.

5. After you edit code, run `graphify update .` (AST-only, free).




## RTK (mandatory)

- Always prefer RTK-wrapped commands when available.
- Never run raw noisy commands if an RTK equivalent exists.

# Native Management & Analytics
rtk init
rtk init --global
rtk init --global --agent cursor
rtk init --codex
rtk config
rtk config recall
rtk discover
rtk session
rtk trust
rtk verify
rtk gain
rtk gain --daily
rtk gain --weekly
rtk gain --history
rtk recall
rtk recall --full
rtk recall --list
rtk proxy
rtk smart

# File, Text & System Inspection Operations
rtk ls
rtk ls -la
rtk tree
rtk cat
rtk read
rtk find
rtk grep
rtk rg
rtk ast-grep
rtk sed
rtk awk
rtk head
rtk tail
rtk wc
rtk diff
rtk du
rtk df
rtk stat
rtk xargs
rtk jq
rtk yq
rtk bat

# Git Operations
rtk git status
rtk git diff
rtk git log
rtk git add
rtk git commit
rtk git push
rtk git pull
rtk git branch
rtk git checkout

# Python Toolchain & Package Managers
rtk python
rtk python3
rtk pytest
rtk ruff check
rtk ruff format
rtk flake8
rtk black
rtk mypy
rtk pip install
rtk pip list
rtk pip freeze
rtk poetry run
rtk poetry install
rtk pipenv run
rtk uv run
rtk uv pip install
rtk conda list

# Flutter & Dart Ecosystem
rtk flutter run
rtk flutter build
rtk flutter test
rtk flutter analyze
rtk flutter doctor
rtk flutter pub get
rtk flutter pub run
rtk flutter pub upgrade
rtk dart analyze
rtk dart test
rtk dart format
rtk dart run
rtk dart pub get

# Rust Toolchain
rtk cargo build
rtk cargo test
rtk cargo check
rtk cargo clippy
rtk cargo run

# JavaScript / TypeScript Ecosystem
rtk npm test
rtk npm install
rtk pnpm test
rtk pnpm install
rtk yarn test
rtk npx eslint
rtk tsc
rtk vitest
rtk playwright
rtk prisma

# Preferred Forms
rtk git status
rtk git diff
rtk git log
rtk ls
rtk test ...
rtk pytest
rtk cargo test
rtk grep ...

- The global RTK hook already rewrites Bash automatically — do not bypass it.

if any of command not found then do it whatever needed and make that command available in rtk.

<!-- rtk-instructions v2 -->
# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk proxy <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
<!-- /rtk-instructions -->