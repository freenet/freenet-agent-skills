/**
 * freenet-agent-skills
 *
 * AI coding agent skills for building applications on Freenet.
 * Compatible with Claude Code and OpenCode.
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');

/**
 * Plugin metadata
 */
const metadata = {
  name: 'freenet-agent-skills',
  description: 'AI coding agent skills for Freenet development',
  version: '1.0.0',
  author: 'Freenet Project',
  license: 'LGPL-3.0'
};

/**
 * Available skill definitions
 */
const skills = {
  'dapp-builder': {
    name: 'freenet-dapp-builder',
    description: 'Build decentralized applications on Freenet using river as a template. Guides through designing contracts (shared state), delegates (private state), and UI.',
    path: path.join(SKILLS_DIR, 'dapp-builder'),
    skillFile: 'SKILL.md',
    references: [
      'references/build-system.md',
      'references/contract-patterns.md',
      'references/delegate-patterns.md',
      'references/ui-patterns.md'
    ]
  },
  'pr-creation': {
    name: 'freenet-pr-creation',
    description: 'Guidelines for creating high-quality Freenet pull requests. Emphasizes quality over speed, thorough testing, and proper review process.',
    path: path.join(SKILLS_DIR, 'pr-creation'),
    skillFile: 'SKILL.md',
    references: []
  },
  'systematic-debugging': {
    name: 'freenet-systematic-debugging',
    description: 'Methodology for debugging non-trivial problems systematically. Emphasizes hypothesis formation, parallel investigation with subagents, and avoiding common anti-patterns.',
    path: path.join(SKILLS_DIR, 'systematic-debugging'),
    skillFile: 'SKILL.md',
    references: []
  }
};

/**
 * Plugin bundles for different use cases
 */
const plugins = {
  'freenet-dapp-builder': {
    name: 'freenet-dapp-builder',
    description: 'Build decentralized applications on Freenet - contracts, delegates, and UI',
    skills: ['dapp-builder']
  },
  'freenet-core-dev': {
    name: 'freenet-core-dev',
    description: 'Freenet core development - PR creation guidelines and systematic debugging methodology',
    skills: ['pr-creation', 'systematic-debugging']
  }
};

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

  return skill.references.map(ref => path.join(skill.path, ref));
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

  return plugin.skills.map(name => skills[name]).filter(Boolean);
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
