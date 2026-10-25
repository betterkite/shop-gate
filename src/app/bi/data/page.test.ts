import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), redirect: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/bi/gateway-scope', () => ({ getBiWorkspaceAccess: mocks.access }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  usePathname: () => '/bi/data', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/auth/AuthUserMenu', () => ({ AuthUserMenu: () => React.createElement('span', null, '账号') }));
vi.mock('@/components/ui/theme-toggle', () => ({ ThemeToggle: () => React.createElement('button', null, '切换主题') }));
import DataPage from './page';
import { AuthorizationError } from '@/lib/auth/authorization';

describe('ledger data center entry is authenticated and clear, never a fake BI completion', () => {
  beforeEach(() => { mocks.access.mockReset().mockResolvedValue({ workspaceId: 'account:a', canManage: true, demoEnabled: true });
    mocks.redirect.mockReset().mockImplementation((href: string) => { throw new Error(`REDIRECT:${href}`); }); });
  it('renders real workflow choices and theme while awaiting actual service data', async () => {
    const output = renderToStaticMarkup(await DataPage({ searchParams: Promise.resolve({}) }));
    expect(output).toContain('数据集与导入中心'); expect(output).toContain('创建数据集');
    expect(output).toContain('正式导入：使用你提供的经营记录'); expect(output).toContain('演示：独立模拟数据');
    expect(output).toContain('切换主题'); expect(output).toContain('无需调用大模型');
    expect(output).not.toContain('已生成看板'); expect(output).not.toContain('local-system-admin');
  });
  it('does not show mutation forms to a read-only account', async () => {
    mocks.access.mockResolvedValue({ workspaceId: 'project-a', canManage: false, demoEnabled: false });
    const output = renderToStaticMarkup(await DataPage({ searchParams: Promise.resolve({ workspace_id: 'project-a' }) }));
    expect(output).toContain('只读'); expect(output).not.toContain('name="confirmed_by_user"');
    expect(output).not.toContain('创建并选择数据集');
  });
  it('redirects unauthenticated requests with a safe local return path', async () => {
    mocks.access.mockRejectedValue(new AuthorizationError('AUTHENTICATION_REQUIRED', 401, 'private'));
    await expect(DataPage({ searchParams: Promise.resolve({ workspace_id: 'project-a' }) })).rejects.toThrow('REDIRECT:/login?next=');
    expect(mocks.redirect).toHaveBeenCalledWith('/login?next=%2Fbi%2Fdata%3Fworkspace_id%3Dproject-a');
  });
  it('restores selected dataset, task and both pages after login without arbitrary return URLs', async () => {
    mocks.access.mockRejectedValue(new AuthorizationError('AUTHENTICATION_REQUIRED', 401, 'private'));
    await expect(DataPage({ searchParams: Promise.resolve({ workspace_id: 'project-a', dataset_id: 'official', dataset_page: '2', job_page: '3', job_id: 'job-a', next: 'https://foreign.test/' }) })).rejects.toThrow('REDIRECT:/login?next=');
    expect(mocks.redirect).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/bi/data?workspace_id=project-a&dataset_id=official&dataset_page=2&job_page=3&job_id=job-a')}`);
  });
  it('never exposes DB errors or silently switches to another dataset/workspace on authorization failure', async () => {
    mocks.access.mockRejectedValue(new Error('postgres://secret@private-host private-sql'));
    const output = renderToStaticMarkup(await DataPage({ searchParams: Promise.resolve({}) }));
    expect(output).toContain('暂时无法确认工作空间权限'); expect(output).not.toContain('secret');
    expect(output).not.toContain('private-sql'); expect(output).not.toContain('创建并选择数据集');
  });
  it('rejects malformed workspace links before looking up any data', async () => {
    const output = renderToStaticMarkup(await DataPage({ searchParams: Promise.resolve({ workspace_id: ['one', 'two'] }) }));
    expect(output).toContain('工作空间链接无效'); expect(mocks.access).not.toHaveBeenCalled();
  });
});
