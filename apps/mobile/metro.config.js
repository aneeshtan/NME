/**
 * Metro, taught about the monorepo.
 *
 * Without this, `@nme/core` resolves to a symlink Metro refuses to follow and
 * the app fails at the first import. The three settings below are the standard
 * Expo monorepo shape: watch the whole repo, look in both `node_modules`
 * directories, and stop walking up the tree past them.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

/**
 * Hoisting means a package can appear in either directory, and letting Metro
 * also search every ancestor directory is how one ends up with two copies of
 * React in the bundle — which fails at runtime with an error that names hooks
 * rather than resolution.
 */
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
