import { NextRequest } from 'next/server';
import { biFailure, postQuery } from '@/lib/bi/http';
import { requireAction } from '@/lib/auth/action';

export async function POST(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await postQuery(request);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
