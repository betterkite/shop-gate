import type { Metadata } from 'next';
import { getStrategyDashboardData } from '@/lib/commerce/strategies';
import StrategyPlatformClient from './StrategyPlatformClient';

export const metadata: Metadata = {
  title: '策略平台 · Shop Gate',
};

export default async function StrategyPlatformPage() {
  const data = await getStrategyDashboardData();
  return <StrategyPlatformClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
