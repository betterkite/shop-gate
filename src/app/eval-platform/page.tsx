import { getCommerceEvalDashboardData } from '@/lib/eval';
import EvalsDashboardClient from './EvalsDashboardClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '评测平台 · Shop Gate',
};

export default async function EvalPlatformPage() {
  const data = await getCommerceEvalDashboardData();
  return <EvalsDashboardClient data={data} />;
}

export const dynamic = 'force-dynamic';
