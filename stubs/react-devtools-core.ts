/**
 * Stub for react-devtools-core.
 *
 * Ink imports it from a branch guarded by DEV === 'true', which never runs
 * here. Bundling the real package would add megabytes of dead code; marking it
 * external fails, because a compiled Bun binary resolves externals eagerly at
 * startup. So it resolves to this instead.
 */
export default {
  connectToDevTools() {},
};
