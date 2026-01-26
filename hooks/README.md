# Git Hooks for Freenet Development

Pre-commit hooks that run before commits to ensure code quality.

## pre-commit

Runs `cargo fmt` and `cargo clippy` before allowing commits.

**Quick install:**

```bash
# From freenet-core repository root
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/hooks/pre-commit > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

**Or copy locally:**

```bash
cp /path/to/freenet-agent-skills/hooks/pre-commit /path/to/freenet-core/.git/hooks/pre-commit
chmod +x /path/to/freenet-core/.git/hooks/pre-commit
```

**What it checks:**
- `cargo fmt --check` - Ensures code is properly formatted
- `cargo clippy --all-targets --all-features -- -D warnings` - Lints all targets including tests

**Worktree setup:**

Each worktree needs the hook installed separately:

```bash
cd ~/code/freenet/freenet-core/fix-123
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/hooks/pre-commit > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

**Bypass (emergency only):**

```bash
git commit --no-verify -m "message"
```

## Note: Pre-Commit Framework

The freenet-core repository officially uses the [pre-commit framework](https://pre-commit.com) with `.pre-commit-config.yaml`.

To use the official setup:

```bash
pip install pre-commit
cd /path/to/freenet-core
pre-commit install
```

This simple bash hook is provided as an alternative for environments where the pre-commit framework isn't available.
