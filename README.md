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

`pr-creation`, `pr-review` and `systematic-debugging` use the plugin's reviewer and investigator agents (`freenet:*`). Install the plugin to get them; copying only the skill directories gives you the text without the agents.

### OpenCode

**Option 1: openskills**
```bash
openskills install freenet/freenet-agent-skills
```

**Option 2: Git clone**

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

See [CLAUDE.md](./CLAUDE.md).

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
