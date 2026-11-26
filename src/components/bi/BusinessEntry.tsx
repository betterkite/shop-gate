import { BUSINESS_SECTIONS, type BusinessSection } from '@/lib/bi/sections';
import React from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getBiWorkspaceAccess } from '@/lib/bi/gateway-scope';
import { AuthorizationError } from '@/lib/auth/authorization';
import { overviewLoginReturnPath } from '@/lib/bi/overview-contracts';
import { OverviewWorkspace } from '@/app/bi/overview/OverviewWorkspace';

export async function BusinessEntry({ section, searchParams, assistantOnly = false }: { assistantOnly?: boolean; section: BusinessSection; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const requested = search.workspace_id;
  let next;
  try {
    if (requested !== undefined && (typeof requested !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(requested))) throw new Error('Invalid workspace');
    next = overviewLoginReturnPath(search, assistantOnly ? 'assistant' : section);
  } catch { return <OverviewEntryError section={section} message="链接中的工作空间或分析范围无效，请从个人经营总览重新选择。" />; }
  let access;
  try { access = await getBiWorkspaceAccess({ headers: await headers(), workspaceId: requested as string | undefined }); }
  catch (error) {
    if (error instanceof AuthorizationError && error.status === 401) redirect(`/login?next=${encodeURIComponent(next)}`);
    return <OverviewEntryError section={section} message={error instanceof AuthorizationError ? '当前账号无权查看此工作空间，请检查账号与共享权限。'
      : '暂时无法确认访问权限，请稍后刷新；已有数据不会改变。'} />;
  }
  return <OverviewWorkspace assistantOnly={assistantOnly} key={section + access.workspaceId} section={section} workspaceId={access.workspaceId} canManage={access.canManage} />;
}
function OverviewEntryError({ section, message }: { section: BusinessSection; message: string }) {
  return <main className="mx-auto max-w-2xl p-8"><h1 className="text-2xl font-semibold">{BUSINESS_SECTIONS[section].title}</h1><p role="alert" className="my-5 text-muted-foreground">{message}</p>
    <Link className="mr-5 text-primary underline" href="/bi/overview">个人经营总览</Link><Link className="text-primary underline" href="/">返回工作台</Link></main>;
}
