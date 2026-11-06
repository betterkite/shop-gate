import { NextRequest } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { biFailure, postReferences } from '@/lib/bi/http';

export async function POST(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
    return await postReferences(request);
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
