import { NextResponse } from 'next/server';
import type { CLIStatus } from '@/types/backend';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { PI_AGENT_MODEL_DEFINITIONS } from '@/lib/constants/models';
import { getProjectLlmConfig } from '@/lib/config/llm';

async function checkPiAgent(): Promise<CLIStatus[string]> {
  const configuredModels = PI_AGENT_MODEL_DEFINITIONS.filter((model) => {
    const config = getProjectLlmConfig(model.id);
    return Boolean(process.env[config.credentialEnv]?.trim());
  });
  const configured = configuredModels.length > 0;

  return {
    installed: true,
    version: 'PI Agent Runtime (built-in)',
    checking: false,
    configured,
    available: configured,
    error: configured
      ? undefined
      : '请在 .env.local 中配置外部模型网关客户端凭据，或配置 DEEPSEEK_API_KEY 使用官方直连。',
    models: configuredModels.map((model) => model.id),
  };
}

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'commerce.data.read',
    });
    const status: CLIStatus = {
      pi: await checkPiAgent(),
    };
    const response = NextResponse.json(status);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to check PI Agent provider status:', error);
    return NextResponse.json(
      {
        error: 'Failed to check PI Agent provider status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
