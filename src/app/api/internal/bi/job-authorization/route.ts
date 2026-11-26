import { NextRequest, NextResponse } from 'next/server';
import { requireBiJobAuthorization } from '@/lib/bi/job-authorization';
import { biFailure } from '@/lib/bi/http';

export async function POST(request: NextRequest) {
  try {
    const token = await requireBiJobAuthorization(request.headers);
    return NextResponse.json({ success: true, data: { token } },
      { headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return biFailure(error); }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
