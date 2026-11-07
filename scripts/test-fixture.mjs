// Public synthetic fixture values, NOT deployment defaults or real secrets.
export function fixtureEnv(input = {}) {
  if (input.ALLOW_DISPOSABLE_TEST_DB !== '1') throw Error('Explicit disposable test database consent is required.');
  let u; try { u = new URL(input.TEST_DATABASE_URL); } catch (_) { throw Error('TEST_DATABASE_URL must name a fresh local test database.'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.search || !/^\/(t|arsenal_test_[a-z0-9_]+)$/.test(u.pathname))
    throw Error('Only a loopback disposable database named t or arsenal_test_* is allowed; no URL options.');
  const port = input.TEST_PORT || '8787';
  if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535) throw Error('Invalid local test port.');
  return { ...input, NODE_ENV:'test', DATABASE_URL:u.href, TEST_DATABASE_URL:u.href, PGSSL:'off', PORT:port, BASE:`http://127.0.0.1:${port}`,
    SESSION_PEPPER:'public-synthetic-ci-only-pepper-not-for-deployment', EVENT_QUOTA:'50', RL_SIGNUP:'1000', RL_TEAM_CREATE:'1000', RL_TEAM_JOIN:'1000', RL_TEAM_JOIN_IP:'1000',
    // Keep the production login limits: the suite MUST exercise the 8/email path.
    RL_LOGIN_EMAIL:'8', RL_LOGIN_IP:'20' };
}
