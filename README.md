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

**Option 1: npm (Recommended)**
```bash
npm install freenet-agent-skills
```

Then symlink to the skills directory:
```bash
ln -s node_modules/freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
ln -s node_modules/freenet-agent-skills/skills/pr-creation ~/.claude/skills/
ln -s node_modules/freenet-agent-skills/skills/systematic-debugging ~/.claude/skills/
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
├── index.js               # OpenCode plugin entry point
├── package.json           # npm package manifest
├── README.md
└── LICENSE
```

## Programmatic API (npm)

When installed via npm, the package exports functions for programmatic access:

```javascript
const skills = require('freenet-agent-skills');

// List available skills
skills.listSkills(); // ['dapp-builder', 'pr-creation', 'systematic-debugging']

// Get skill metadata
skills.getSkill('dapp-builder');

// Read skill content
const content = skills.readSkill('dapp-builder');

// Get paths for integration
skills.getSkillsPath();       // Absolute path to skills directory
skills.getSkillPath('dapp-builder');  // Path to SKILL.md

// Work with plugin bundles
skills.listPlugins();  // ['freenet-dapp-builder', 'freenet-core-dev']
skills.getPluginSkills('freenet-core-dev');  // Skills in the plugin
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
