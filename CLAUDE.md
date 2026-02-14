# Freenet Agent Skills - Version Information

**Current Version:** 1.0.1

## Version History

### 1.0.1 (2026-02-14)
- Added claude.md for version tracking
- Established version update workflow

### 1.0.0 (Initial Release)
- dapp-builder skill for building Freenet applications
- pr-creation skill for Freenet PR guidelines
- systematic-debugging skill for debugging methodology
- pr-review skill
- Claude Code hooks for cargo fmt and clippy
- Git pre-commit hooks

## Updating the Version

When making changes to the plugin:

1. **Update marketplace.json**: Increment the version in `.claude-plugin/marketplace.json` → `metadata.version`
2. **Update claude.md**: Add entry to version history with date and changes
3. **Commit both files**: Ensure both files are committed together

### Version Numbering

Follow semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Breaking changes to skill structure or API
- **MINOR**: New skills or significant feature additions
- **PATCH**: Bug fixes, documentation updates, minor improvements

## Encoding

This file serves as the canonical version reference and should be updated every time:
- New skills are added
- Existing skills are modified
- Documentation is significantly updated
- Hooks are changed
- Agent definitions are modified
