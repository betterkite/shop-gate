import type { Metadata } from 'next';
import React from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getBiWorkspaceAccess } from '@/lib/bi/gateway-scope';
import { AuthorizationError } from '@/lib/auth/authorization';
import { DataCenter } from './DataCenter';

export const metadata: Metadata = { title: '经营数据 · Shop Gate',
  description: '选择经营数据集，预览并确认标准数据导入，查看处理进度与数据版本。' };
export const dynamic = 'force-dynamic';

export default async function DataPage({ searchParams }: {
  searchParams: Promise<{ workspace_id?: string | string[] }>;
}) {
  const requested = (await searchParams).workspace_id;
  if (requested !== undefined && (typeof requested !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(requested))) {
    return <DataPageError message="工作空间链接无效，请从个人工作空间重新选择。" />;
  }
  let access;
  try { access = await getBiWorkspaceAccess({ headers: await headers(), workspaceId: requested }); }
  catch (error) {
    if (error instanceof AuthorizationError && error.status === 401) {
      const next = `/bi/data${requested ? `?workspace_id=${encodeURIComponent(requested)}` : ''}`;
      redirect(`/login?next=${encodeURIComponent(next)}`);
    }
    return <DataPageError message={error instanceof AuthorizationError
      ? '当前账号无权查看此工作空间。可以返回个人工作空间，或请管理员检查共享权限。'
      : '暂时无法确认工作空间权限，请稍后刷新；不会显示其他账号的数据。'} />;
  }
  return <DataCenter key={access.workspaceId} {...access} />;
}

function DataPageError({ message }: { message: string }) {
  return <main className="mx-auto max-w-2xl p-8"><h1 className="text-2xl font-semibold">经营数据</h1>
    <p role="alert" className="my-5 text-muted-foreground">{message}</p>
    <Link className="mr-5 text-primary underline" href="/bi/data">个人工作空间</Link>
    <Link className="text-primary underline" href="/">返回工作台</Link></main>;
}
