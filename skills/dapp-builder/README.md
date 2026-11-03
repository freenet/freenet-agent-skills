# Freenet dApp Builder

AI agent skill for building decentralized applications on Freenet.

## What This Skill Does

Guides you through building decentralized apps following the architecture patterns established in [River](https://github.com/freenet/river) (decentralized chat). Covers:

1. **Contract Design** - Shared, replicated state running on untrusted peers
2. **Delegate Design** - Private, local state and cryptographic operations
3. **UI Design** - WebSocket connection to Freenet gateway

## Installation

### Claude Code (Recommended)

```bash
/plugin marketplace add freenet/freenet-agent-skills
/plugin install freenet@freenet-agent-skills
```

The dapp-builder skill is bundled inside the `freenet` plugin along with the other Freenet skills.

### Manual Installation

```bash
git clone https://github.com/freenet/freenet-agent-skills.git
cp -r freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
```

Or symlink for easier updates:

```bash
ln -s ~/freenet-agent-skills/skills/dapp-builder ~/.claude/skills/
```

## Usage

Once installed, Claude will automatically use this skill when you ask about building Freenet apps. You can also invoke it directly:

- "Build a decentralized Reddit clone"

## Files

- `SKILL.md` - Main skill instructions, with a table routing each task to its reference
- `references/` - Detailed documentation, loaded on demand

## Reference Project

[River](https://github.com/freenet/river) is the reference implementation demonstrating all patterns.

## License

LGPL-3.0
