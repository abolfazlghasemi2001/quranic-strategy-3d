/**
 * SocialState — persisted multiplayer preferences ONLY.
 *
 * The authoritative ledger (resources, timers, event progress) always lives on
 * the server and is never saved locally. This block only remembers how the
 * player likes to connect: display name, child flag and the reconnect token.
 */

export function createSocialPrefs() {
  return {
    displayName: '',
    isChild: false,
    token: null,
    jamaatId: null,
  };
}

/** Shape and clamp at every save boundary; old saves get harmless defaults. */
export function normalizeSocialPrefs(raw) {
  const fallback = createSocialPrefs();
  if (!raw || typeof raw !== 'object') return fallback;
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.slice(0, 16) : '';
  const token = typeof raw.token === 'string' && raw.token.length <= 128 ? raw.token : null;
  const jamaatId = typeof raw.jamaatId === 'string' ? raw.jamaatId.slice(0, 64) : null;
  return {
    displayName,
    isChild: raw.isChild === true,
    token,
    jamaatId,
  };
}
