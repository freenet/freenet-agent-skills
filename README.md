# Freenet Agent Skills

AI coding agent skills for building applications on Freenet. Compatible with [Claude Code](https://claude.ai/code) and [OpenCode](https://opencode.ai/).

## Available Skills

### [dapp-builder](./skills/dapp-builder/)

Build decentralized applications on Freenet. Guides through:
1. Designing contracts (shared, replicated state)
2. Implementing delegates (private, local state)
3. Building the UI (WebSocket connection to Freenet)

Based on [River](https://github.com/freenet/river), a decentralized chat application.

### [pr-creation](./skills/pr-creation/)

Guidelines for creating high-quality Freenet pull requests. Includes:
- Four parallel review subagents (code-first, testing, skeptical, big-picture)
- Big-picture review catches "CI chasing" anti-patterns
- Test quality standards and regression prevention
- Worktree-based workflow

### [systematic-debugging](./skills/systematic-debugging/)

Methodology for debugging non-trivial problems:
- Hypothesis formation before code changes
- Parallel investigation with subagents
- Anti-patterns to avoid (jumping to conclusions, weakening tests)
- Test coverage gap analysis

## Hooks

The [`hooks/`](./hooks/) directory contains two types of hooks for Freenet development:

### 1. Claude Code Hooks (Automatic)

**File**: `hooks/hooks.json`

Automatically runs `cargo fmt` and `cargo clippy` **before** Claude runs git commits. Included with the plugin - no setup required.

### 2. Git Pre-Commit Hook (Manual)

**File**: `hooks/pre-commit`

Runs `cargo fmt` and `cargo clippy` before git commits. Must be installed manually:

```bash
# From freenet-core repository
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/hooks/pre-commit > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

See [hooks/README.md](./hooks/README.md) for full details and comparison.

## Installation

### Claude Code (Recommended)

Add the marketplace:

```bash
/plugin marketplace add freenet/freenet-agent-skills
```

Then install the plugin you need:

```bash
# For building apps on Freenet
/plugin install freenet-dapp-builder

# For contributing to Freenet core
/plugin install freenet-core-dev
```

Or browse available plugins via `/plugin` → **Discover** tab.

### Manual Installation

**Option 1: Copy individual skills**
```bash
git clone https://github.com/freenet/freenet-agent-skills.git
cp -r freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
```

**Option 2: Symlink** (easier to update)
```bash
git clone https://github.com/freenet/freenet-agent-skills.git ~/freenet-agent-skills
ln -s ~/freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
```

### OpenCode

OpenCode automatically discovers skills from Claude-compatible paths:

```bash
git clone https://github.com/freenet/freenet-agent-skills.git ~/freenet-agent-skills
ln -s ~/freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
ln -s ~/freenet-agent-skills/skills/pr-creation ~/.claude/skills/
ln -s ~/freenet-agent-skills/skills/systematic-debugging ~/.claude/skills/
```

### Project-specific Installation

To include a skill in a specific project (shared with team):

```bash
mkdir -p .claude/skills
cp -r freenet-agent-skills/skills/dapp-builder .claude/skills/
git add .claude/skills
```

**Verify installation:**
Ask your AI agent: "What skills are available?" - it should list the installed skills.

## Repository Structure

```
freenet-agent-skills/
├── .claude-plugin/
│   └── marketplace.json   # Claude Code marketplace manifest
├── skills/
│   ├── dapp-builder/
│   │   ├── SKILL.md       # Main skill definition
│   │   ├── README.md      # Skill documentation
│   │   └── references/    # Detailed documentation
│   ├── pr-creation/
│   │   └── SKILL.md
│   └── systematic-debugging/
│       └── SKILL.md
├── hooks/
│   ├── hooks.json         # Claude Code hooks (run before git commit)
│   ├── pre-commit         # Git pre-commit hook for cargo fmt/clippy
│   └── README.md
├── agents/                # Subagent definitions (reviewers, etc.)
├── README.md
└── LICENSE
```

## Version Management

See [CLAUDE.md](./CLAUDE.md) for the current version and version history. When making changes:

1. Update `.claude-plugin/marketplace.json` → `metadata.version`
2. Update `CLAUDE.md` with version number and changelog entry
3. Commit both files together

## Contributing

Skills follow the structure:

```
skill-name/
├── SKILL.md           # Main instructions (required, with YAML frontmatter)
└── references/        # Detailed documentation loaded on-demand (optional)
```

SKILL.md files require YAML frontmatter:

```yaml
---
name: skill-name          # Must match directory name
description: Brief description of what the skill does
license: LGPL-3.0         # Optional
---
```

## License

LGPL-3.0
