import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, getBatchHistory } from '@/lib/bi/http';

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await getBatchHistory(request);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
