# Freenet Agent Skills

AI coding agent skills for building applications on Freenet. Compatible with [Claude Code](https://claude.ai/code) and [OpenCode](https://opencode.ai/).

## Available Skills

- [dapp-builder](./skills/dapp-builder/): build decentralized applications on Freenet (contracts, delegates, UI), based on [River](https://github.com/freenet/river).
- [local-dev](./skills/local-dev/): run a local node, publish contracts, query diagnostics and iterate without deploying to the live network.
- [pr-creation](./skills/pr-creation/): standards for opening a high-quality Freenet pull request.
- [pr-review](./skills/pr-review/): risk-tiered, multi-perspective PR review with parallel specialist subagents and an external model pass.
- [systematic-debugging](./skills/systematic-debugging/): hypothesis-driven debugging with a scope ladder from unit test to real network.
- [release](./skills/release/): orchestrates a Freenet release, from the mandatory pre-cut gates through post-release monitoring.
- [linux-test](./skills/linux-test/): runs integration tests that need Linux's full loopback range in Docker.

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

Then install the plugin:

```bash
/plugin install freenet@freenet-agent-skills
```

This installs all bundled skills (dapp-builder, pr-creation, pr-review, release, systematic-debugging, linux-test, local-dev). Browse via `/plugin` → **Discover** tab to confirm.

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

**Option 1: npm (Recommended)**
```bash
npm install freenet-agent-skills
```

Then symlink the skills you want to the skills directory (see [Available Skills](#available-skills)
above for the full list), e.g.:
```bash
ln -s node_modules/freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
ln -s node_modules/freenet-agent-skills/skills/pr-creation ~/.claude/skills/
```

Or symlink all of them programmatically:
```bash
node -e "require('freenet-agent-skills').listSkills().forEach(s => \
  console.log(require('freenet-agent-skills').getSkill(s).path))"
```

**Option 2: openskills**
```bash
openskills install freenet/freenet-agent-skills
```

**Option 3: Git clone**

OpenCode automatically discovers skills from Claude-compatible paths:

```bash
git clone https://github.com/freenet/freenet-agent-skills.git ~/freenet-agent-skills
ln -s ~/freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
ln -s ~/freenet-agent-skills/skills/pr-creation ~/.claude/skills/
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

## Version Management

See [CLAUDE.md](./CLAUDE.md) for the current version and version history. When making changes:

1. Update `.claude-plugin/marketplace.json` → `metadata.version`
2. Update `CLAUDE.md` with version number and changelog entry
3. Commit both files together

## Programmatic API (npm)

When installed via npm, the package exports functions for programmatic access. `listSkills()` and
`listPlugins()` are derived from the `skills/` directory and `.claude-plugin/marketplace.json` at
require-time, so they always reflect what's actually in the repo:

```javascript
const skills = require('freenet-agent-skills');

// List available skills (reads skills/ on require, not a hardcoded list)
skills.listSkills(); // ['dapp-builder', 'linux-test', 'local-dev', 'pr-creation', 'pr-review', 'release', 'systematic-debugging']

// Get skill metadata
skills.getSkill('dapp-builder');

// Read skill content
const content = skills.readSkill('dapp-builder');

// Get paths for integration
skills.getSkillsPath();       // Absolute path to skills directory
skills.getSkillPath('dapp-builder');  // Path to SKILL.md

// Work with plugin bundles (reads .claude-plugin/marketplace.json)
skills.listPlugins();  // ['freenet']
skills.getPluginSkills('freenet');  // All skill metadata objects in the plugin
```

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
