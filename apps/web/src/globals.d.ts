/**
 * Constants substituted by Vite's `define` at build time — see vite.config.ts.
 *
 * Declared here rather than on `globalThis` because that is what they are: the
 * bundler replaces the identifier with a string literal before the code ever
 * runs, so there is no property to look up and nothing to guard against being
 * absent.
 */

/** Semver from package.json, e.g. `1.0.0`. Shown in the footer so a bug report
 *  can name the build it came from. */
declare const __APP_VERSION__: string;

/** Four-digit year the bundle was built, used for the copyright notice. */
declare const __BUILD_YEAR__: string;
