import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureEnv} from '../scripts/test-fixture.mjs';
const base={ALLOW_DISPOSABLE_TEST_DB:'1',TEST_DATABASE_URL:'postgres://u:p@127.0.0.1:5432/t'};
test('fixture requires explicit local disposable consent and rejects remote databases/options',()=>{
 for(const input of [{}, {...base,ALLOW_DISPOSABLE_TEST_DB:'0'}, {...base,TEST_DATABASE_URL:'postgres://u:p@db.example/t'}, {...base,TEST_DATABASE_URL:'postgres://u:p@localhost/real'}, {...base,TEST_DATABASE_URL:base.TEST_DATABASE_URL+'?host=db.example'}]) assert.throws(()=>fixtureEnv(input));
});
test('test-only env replaces inherited secrets/destinations and preserves real login-rate assertions',()=>{
 const e=fixtureEnv({...base,SESSION_PEPPER:'not-read-or-used',DATABASE_URL:'unused',BASE:'https://unused.example',RL_LOGIN_EMAIL:'900',RL_LOGIN_IP:'900'});
 assert.equal(e.NODE_ENV,'test');assert.equal(e.SESSION_PEPPER,'public-synthetic-ci-only-pepper-not-for-deployment');assert.equal(e.DATABASE_URL,base.TEST_DATABASE_URL);assert.equal(e.BASE,'http://127.0.0.1:8787');assert.equal(e.RL_LOGIN_EMAIL,'8');assert.equal(e.RL_LOGIN_IP,'20');assert.equal(e.TEST_DATABASE_URL,e.DATABASE_URL);
});
