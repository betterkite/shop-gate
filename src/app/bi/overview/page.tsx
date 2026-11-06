import type { Metadata } from 'next';
import React from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getBiWorkspaceAccess } from '@/lib/bi/gateway-scope';
import { AuthorizationError } from '@/lib/auth/authorization';
import { overviewLoginReturnPath } from '@/lib/bi/overview-contracts';
import { OverviewWorkspace } from './OverviewWorkspace';

export const metadata: Metadata = { title: '经营总览 · Shop Gate', description: '使用订单、退款、历史成本与费用查看经营变化、销售平台贡献和月度目标。' };
export const dynamic = 'force-dynamic';
export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const requested = search.workspace_id;
  let next;
  try {
    if (requested !== undefined && (typeof requested !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(requested))) throw new Error('Invalid workspace');
    next = overviewLoginReturnPath(search);
  } catch { return <OverviewEntryError message="链接中的工作空间或分析范围无效，请从个人经营总览重新选择。" />; }
  let access;
  try { access = await getBiWorkspaceAccess({ headers: await headers(), workspaceId: requested as string | undefined }); }
  catch (error) {
    if (error instanceof AuthorizationError && error.status === 401) redirect(`/login?next=${encodeURIComponent(next)}`);
    return <OverviewEntryError message={error instanceof AuthorizationError ? '当前账号无权查看此工作空间，请检查账号与共享权限。'
      : '暂时无法确认访问权限，请稍后刷新；已有数据不会改变。'} />;
  }
  return <OverviewWorkspace key={access.workspaceId} workspaceId={access.workspaceId} canManage={access.canManage} />;
}
function OverviewEntryError({ message }: { message: string }) {
  return <main className="mx-auto max-w-2xl p-8"><h1 className="text-2xl font-semibold">经营总览</h1><p role="alert" className="my-5 text-muted-foreground">{message}</p>
    <Link className="mr-5 text-primary underline" href="/bi/overview">个人经营总览</Link><Link className="text-primary underline" href="/">返回工作台</Link></main>;
}
