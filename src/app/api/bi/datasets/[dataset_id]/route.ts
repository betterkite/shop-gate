import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, getDataset } from '@/lib/bi/http';

export async function GET(request: NextRequest, context: { params: Promise<{ dataset_id: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await getDataset(request, (await context.params).dataset_id);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
