import { NextRequest } from 'next/server';
import { biFailure, getDatasets, postDataset } from '@/lib/bi/http';
import { requireAction } from '@/lib/auth/action';

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await getDatasets(request);
  } catch (error) { return biFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.operation.manage' });
    return await postDataset(request);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
