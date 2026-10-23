/**
 * dsh-inkstone bundle root entry.
 *
 * The bundle exposes four subpath plugins through cordis.patch.yml; this root
 * module only exists so package resolution and bundle validation have a valid
 * package entry point. It registers nothing.
 */
export const name = 'inkstone';

export function apply() {}
