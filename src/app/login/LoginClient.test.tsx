import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authClient: { signIn: { email: vi.fn() } } }));
import LoginClient from './LoginClient';

it('does not advertise guessed development credentials on the public login page', () => {
  const html = renderToStaticMarkup(<LoginClient rememberMe={false}
    developmentAdmin={{ login: 'admin', email: 'admin@shopgate.local' }} nextPath="/bi/data" />);
  expect(html).not.toContain('shopgate2025');
  expect(html).not.toContain('admin@shopgate.local');
  expect(html).not.toContain('本地默认');
  expect(html).toContain('经营数据');
  expect(html).toContain('使用管理员为你创建的账号登录');
});
