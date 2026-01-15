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

## Installation

### Claude Code (Plugin)

Install as a plugin for full integration:

```bash
git clone https://github.com/freenet/freenet-agent-skills.git ~/freenet-agent-skills
```

Then add to your Claude Code settings (`.claude/settings.json`):

```json
{
  "plugins": ["~/freenet-agent-skills"]
}
```

### Claude Code (Manual)

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

Or use OpenCode's native path:

```bash
mkdir -p ~/.config/opencode/skill
ln -s ~/freenet-agent-skills/skills/dapp-builder ~/.config/opencode/skill/
```

### Project-specific installation

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
│   └── plugin.json        # Claude Code plugin manifest
├── skills/
│   ├── dapp-builder/
│   │   ├── SKILL.md       # Main skill definition
│   │   └── references/    # Detailed documentation
│   ├── pr-creation/
│   │   └── SKILL.md
│   └── systematic-debugging/
│       └── SKILL.md
├── README.md
└── LICENSE
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
