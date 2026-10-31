import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, postTarget } from '@/lib/bi/http';

export async function POST(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.operation.manage' });
    return await postTarget(request, 'preview');
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
