/**
 * freenet-agent-skills
 *
 * AI coding agent skills for building applications on Freenet.
 * Compatible with Claude Code and OpenCode.
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');
const MARKETPLACE_PATH = path.join(__dirname, '.claude-plugin', 'marketplace.json');

/**
 * Plugin metadata
 */
const metadata = {
  name: 'freenet-agent-skills',
  description: 'AI coding agent skills for Freenet development',
  version: require('./package.json').version,
  author: 'Freenet Project',
  license: 'LGPL-3.0'
};

/**
 * Parse the YAML frontmatter of a SKILL.md file. Frontmatter here is always
 * flat `key: value` pairs, so a hand-rolled parser avoids taking on a YAML
 * dependency for this one use.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    frontmatter[key] = value;
  }
  return frontmatter;
}

/**
 * Discover skills from the skills/ directory. This reads the filesystem at
 * require-time rather than hardcoding a skill list — a hardcoded list goes
 * stale the moment a skill is added, renamed, or removed (see repo history:
 * this is what made the original version of this file wrong within weeks).
 */
function discoverSkills() {
  const result = {};
  if (!fs.existsSync(SKILLS_DIR)) return result;

  const entries = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(SKILLS_DIR, entry.name);
    const skillFile = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    const referencesDir = path.join(skillPath, 'references');
    const references = fs.existsSync(referencesDir)
      ? fs
          .readdirSync(referencesDir)
          .filter((f) => f.endsWith('.md'))
          .sort()
          .map((f) => path.join('references', f))
      : [];

    result[entry.name] = {
      name: frontmatter.name || entry.name,
      description: frontmatter.description || '',
      path: skillPath,
      skillFile: 'SKILL.md',
      references
    };
  }
  return result;
}

/**
 * Discover plugin bundles from the marketplace manifest — the same file
 * Claude Code reads to install skills — rather than re-describing the
 * bundle structure here where it can drift out of sync.
 */
function discoverPlugins() {
  const result = {};
  if (!fs.existsSync(MARKETPLACE_PATH)) return result;

  const manifest = JSON.parse(fs.readFileSync(MARKETPLACE_PATH, 'utf8'));
  for (const plugin of manifest.plugins || []) {
    result[plugin.name] = {
      name: plugin.name,
      description: plugin.description,
      skills: (plugin.skills || []).map((skillPath) => path.basename(skillPath))
    };
  }
  return result;
}

const skills = discoverSkills();
const plugins = discoverPlugins();

/**
 * Get the path to the skills directory
 * @returns {string} Absolute path to skills directory
 */
function getSkillsPath() {
  return SKILLS_DIR;
}

/**
 * List all available skills
 * @returns {string[]} Array of skill names
 */
function listSkills() {
  return Object.keys(skills);
}

/**
 * Get skill metadata
 * @param {string} skillName - Name of the skill
 * @returns {object|null} Skill metadata or null if not found
 */
function getSkill(skillName) {
  return skills[skillName] || null;
}

/**
 * Get the full path to a skill's SKILL.md file
 * @param {string} skillName - Name of the skill
 * @returns {string|null} Absolute path to SKILL.md or null if not found
 */
function getSkillPath(skillName) {
  const skill = skills[skillName];
  if (!skill) return null;
  return path.join(skill.path, skill.skillFile);
}

/**
 * Read a skill's SKILL.md content
 * @param {string} skillName - Name of the skill
 * @returns {string|null} Content of SKILL.md or null if not found
 */
function readSkill(skillName) {
  const skillPath = getSkillPath(skillName);
  if (!skillPath) return null;

  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * Get all reference file paths for a skill
 * @param {string} skillName - Name of the skill
 * @returns {string[]} Array of absolute paths to reference files
 */
function getReferencePaths(skillName) {
  const skill = skills[skillName];
  if (!skill) return [];

  return skill.references.map((ref) => path.join(skill.path, ref));
}

/**
 * Read a specific reference file
 * @param {string} skillName - Name of the skill
 * @param {string} referenceName - Name of the reference file (e.g., 'contract-patterns.md')
 * @returns {string|null} Content of the reference file or null if not found
 */
function readReference(skillName, referenceName) {
  const skill = skills[skillName];
  if (!skill) return null;

  const refPath = path.join(skill.path, 'references', referenceName);

  try {
    return fs.readFileSync(refPath, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * List available plugins
 * @returns {string[]} Array of plugin names
 */
function listPlugins() {
  return Object.keys(plugins);
}

/**
 * Get plugin metadata
 * @param {string} pluginName - Name of the plugin
 * @returns {object|null} Plugin metadata or null if not found
 */
function getPlugin(pluginName) {
  return plugins[pluginName] || null;
}

/**
 * Get all skills in a plugin
 * @param {string} pluginName - Name of the plugin
 * @returns {object[]} Array of skill metadata objects
 */
function getPluginSkills(pluginName) {
  const plugin = plugins[pluginName];
  if (!plugin) return [];

  return plugin.skills.map((name) => skills[name]).filter(Boolean);
}

module.exports = {
  // Metadata
  metadata,
  skills,
  plugins,

  // Path functions
  getSkillsPath,
  getSkillPath,
  getReferencePaths,

  // Listing functions
  listSkills,
  listPlugins,

  // Getter functions
  getSkill,
  getPlugin,
  getPluginSkills,

  // Reader functions
  readSkill,
  readReference
};
