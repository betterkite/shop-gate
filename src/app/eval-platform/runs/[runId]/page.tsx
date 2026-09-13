import { notFound } from 'next/navigation';
import { getCommerceEvalRun } from '@/lib/eval';
import EvalRunDetailClient from './EvalRunDetailClient';

export default async function EvalRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const run = await getCommerceEvalRun(runId);
  if (!run) {
    notFound();
  }
  return <EvalRunDetailClient run={run} />;
}

export const dynamic = 'force-dynamic';
