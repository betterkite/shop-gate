import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';
import {
  DEFAULT_RETAIL_CAPABILITY_ID,
  serializeRetailCapabilities,
} from '@/lib/domains/retail/capabilities';

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'commerce.data.read' });
  } catch (error) {
    return authErrorResponse(error);
  }
  return NextResponse.json({
    success: true,
    data: {
      defaultCapabilityId: DEFAULT_RETAIL_CAPABILITY_ID,
      capabilities: serializeRetailCapabilities(),
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
