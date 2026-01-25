---
name: pre-commit-hooks
description: Sets up Git pre-commit hooks for freenet-core that automatically run cargo fmt and cargo clippy (including test targets) before each commit
license: LGPL-3.0
---

# Freenet Core Pre-Commit Hooks

This skill provides multiple approaches to set up pre-commit hooks for Rust projects (especially freenet-core) that ensure code quality before committing.

## Three Approaches

### Option 1: Simple Bash Script (No Dependencies)

**Best for:** Quick setup, any Rust project, no additional tools required

A standalone bash script that runs cargo fmt and clippy before each commit.

**Setup:**
```bash
# From this repository
cp skills/pre-commit-hooks/references/pre-commit-hook.sh /path/to/freenet-core/.git/hooks/pre-commit
chmod +x /path/to/freenet-core/.git/hooks/pre-commit

# Or download directly
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/skills/pre-commit-hooks/references/pre-commit-hook.sh > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

**What it checks:**
- `cargo fmt --check` - Ensures code is properly formatted
- `cargo clippy --all-targets --all-features -- -D warnings` - Lints all targets including tests

**Worktree compatibility:** Install in each worktree separately (each has its own `.git/hooks/` directory)

---

### Option 2: Pre-Commit Framework (Freenet-Core's Official Approach)

**Best for:** Working in freenet-core repository, team consistency, advanced features

The freenet-core repository uses the official **pre-commit framework** (https://pre-commit.com) with comprehensive checks configured in `.pre-commit-config.yaml`.

**What it includes:**
- **cargo fmt** - Code formatting
- **Smart Clippy** - Custom script that only lints packages with modified files (performance optimization)
- **YAML validation** - Ensures YAML files are valid
- **Merge conflict detection** - Prevents accidental conflict markers
- **TODO-MUST-FIX blocker** - Prevents commits with TODO-MUST-FIX markers
- **Conventional Commits** - Validates commit message format (via `.githooks/commit-msg`)

**Setup:**
```bash
# 1. Install pre-commit framework
pip install pre-commit
# OR: brew install pre-commit
# OR: conda install -c conda-forge pre-commit

# 2. Install hooks in repository
cd /path/to/freenet-core
pre-commit install

# 3. (Optional) Enable commit message validation
git config core.hooksPath .githooks

# 4. Verify
pre-commit run --all-files
```

**Documentation:**
- See `docs/PRE_COMMIT_HOOK_GUIDE.md` in freenet-core repository
- Configuration: `.pre-commit-config.yaml`
- Custom clippy: `scripts/pre-commit-clippy.sh`

---

### Option 3: Claude Code Native Hooks (Real-Time Checks)

**Best for:** Catching issues during Claude Code sessions, real-time feedback

Claude Code has a native hook system that can run checks when Claude edits files, before tool execution, or at other events.

**Setup:**

Create or edit `.claude/settings.json` in your project:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'file=\"$(echo \"$STDIN\" | jq -r .tool_input.file_path)\"; if [[ $file == *.rs ]]; then cargo fmt && cargo clippy --all-targets -- -D warnings; fi'"
          }
        ]
      }
    ]
  }
}
```

**How it works:**
- Runs **after** Claude edits or writes `.rs` files
- Provides real-time feedback during the session
- Catches issues before you even commit

**Events available:**
- `PreToolUse` - Before tool calls (can block them)
- `PostToolUse` - After tool calls complete
- `UserPromptSubmit` - When user submits a prompt
- `Stop` - When Claude finishes responding
- And more...

**Documentation:** https://code.claude.com/docs/en/hooks-guide.md

---

## Comparison

| Feature | Bash Script | Pre-Commit Framework | Claude Code Hooks |
|---------|-------------|---------------------|-------------------|
| **When runs** | On `git commit` | On `git commit` | During Claude's work |
| **Dependencies** | None (just bash) | Requires `pre-commit` | Built into Claude Code |
| **Setup complexity** | Very simple | Medium | Medium |
| **Checks** | fmt + clippy | fmt + clippy + more | Customizable |
| **Performance** | Checks everything | Smart per-package | Checks changed files |
| **Team use** | Manual setup each | Framework-managed | Per-developer config |
| **Best for** | Quick start | Official freenet-core | Real-time feedback |

---

## Recommended Approach

**For freenet-core contributors:**
1. Use **Option 2** (pre-commit framework) - it's the official approach
2. Optionally add **Option 3** (Claude Code hooks) for real-time feedback during development

**For other Rust projects:**
1. Start with **Option 1** (bash script) - simple and works everywhere
2. Upgrade to **Option 2** (pre-commit framework) as project grows

**For Claude Code users:**
- Add **Option 3** (Claude Code hooks) to catch issues during AI-assisted development

---

## Usage

### With Bash Script or Pre-Commit Framework

```bash
# Normal workflow
git add src/file.rs
git commit -m "fix: improve error handling"
# Hooks run automatically

# If formatting fails
cargo fmt
git add -u
git commit -m "fix: improve error handling"

# If clippy fails
# Fix the specific issues reported
git add .
git commit -m "fix: improve error handling"

# Bypass (emergency only)
git commit --no-verify -m "emergency fix"
```

### With Pre-Commit Framework (Additional Commands)

```bash
# Run manually on staged files
pre-commit run

# Run on all files
pre-commit run --all-files

# Skip specific hook
SKIP=cargo-clippy git commit -m "message"

# Update hooks
pre-commit autoupdate
```

### With Claude Code Hooks

Hooks run automatically during Claude's workflow. Check Claude's output for any hook failures.

---

## Worktree Setup

Git worktrees have separate `.git/hooks` directories.

**Bash Script:**
```bash
# Install in each worktree
cd ~/code/freenet/freenet-core/main
cp /path/to/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

cd ~/code/freenet/freenet-core/fix-123
cp /path/to/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

**Pre-Commit Framework:**
```bash
# Install in each worktree
cd ~/code/freenet/freenet-core/main
pre-commit install

cd ~/code/freenet/freenet-core/fix-123
pre-commit install
```

**Claude Code Hooks:**
- Configure once in `.claude/settings.json` at project root
- Works across all worktrees

---

## Troubleshooting

### Bash Script Issues

**Hook doesn't run:**
```bash
ls -l .git/hooks/pre-commit  # Check it exists and is executable
chmod +x .git/hooks/pre-commit
```

**Cargo commands fail:**
```bash
pwd  # Make sure you're in project root
ls Cargo.toml  # Should exist
```

### Pre-Commit Framework Issues

**`pre-commit: command not found`:**
```bash
pip install pre-commit
```

**Hooks don't run:**
```bash
pre-commit install  # Reinstall
```

**First run is slow:**
- Expected - downloads hook environments
- Subsequent runs are cached and fast

### Claude Code Hooks Issues

**Hook not triggering:**
- Check JSON syntax in settings.json
- Verify matcher pattern includes your tool
- Check Claude's output for hook errors

**Hook command fails:**
- Test command manually in terminal
- Check file paths are correct
- Use `echo` commands to debug stdin data

---

## CI Alignment

All approaches align with freenet-core's CI (`.github/workflows/ci.yml`):

**Checks:**
- `cargo fmt --check`
- `cargo clippy --locked -- -D warnings`
- Full test suite (CI only)

By running fmt and clippy locally first, you avoid the cycle of: push → CI fails → fix → push again.

---

## References

- **Bash script:** `skills/pre-commit-hooks/references/pre-commit-hook.sh`
- **Setup guide:** `skills/pre-commit-hooks/references/setup-instructions.md`
- **Pre-commit framework:** https://pre-commit.com
- **Freenet-core hook guide:** `docs/PRE_COMMIT_HOOK_GUIDE.md` (in freenet-core repo)
- **Claude Code hooks:** https://code.claude.com/docs/en/hooks-guide.md
- **Conventional Commits:** https://www.conventionalcommits.org
