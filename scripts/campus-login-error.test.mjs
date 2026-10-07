import assert from 'node:assert/strict';
import test from 'node:test';
import { wpyLoginErrorMessage } from '../src/lib/campus-login-error.ts';

const error = (id, upstream_code) => ({ body: { error: { id, upstream_code } } });

test('Wpy login diagnostics reject raw messages and unbounded service codes', () => {
  for (const code of ['<private-message>', -1, 100000, 1.5, NaN, Infinity, null]) {
    const message = wpyLoginErrorMessage(error('campus_auth_rejected', code));
    assert.equal(message, '微北洋认证服务未接受请求；无法据此判断密码是否正确，请反馈此提示。');
  }
});

test('Wpy verification and tool connections use the same safe credential diagnostics', () => {
  for (const code of [40002, 40004, 50003]) {
    const id = code === 50003 ? 'campus_auth_rejected' : 'campus_invalid_credentials';
    assert.equal(wpyLoginErrorMessage(error(id, code)), wpyLoginErrorMessage(error(id, code), true));
    assert.match(wpyLoginErrorMessage(error(id, code)), new RegExp(`服务码 ${code}`));
  }
  assert.match(wpyLoginErrorMessage(error('campus_invalid_credentials')), /若官方 App 可登录/);
});

test('Missing login results are distinct from office data failures and never confirm a bad password', () => {
  assert.equal(wpyLoginErrorMessage(error('campus_invalid_response')), null);
  assert.match(wpyLoginErrorMessage(error('campus_invalid_response'), true), /不代表密码错误/);
  assert.match(wpyLoginErrorMessage(error('campus_invalid_response', 0)), /服务码 0/);
  assert.equal(wpyLoginErrorMessage(error('campus_office_credentials_invalid')), null);
  for (const value of [null, undefined, false, {}, new Error('private-message')]) {
    assert.equal(wpyLoginErrorMessage(value), null);
  }
});
