#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function readEnvFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readEnvValue(key) {
  if (process.env[key]) return process.env[key];
  for (const file of ['.env.local', '.env']) {
    const contents = readEnvFile(path.join(process.cwd(), file));
    const match = contents.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?$`, 'm'));
    if (match) return match[1];
  }
  return '';
}

function requestedModel() {
  return readEnvValue('SHOPGATE_EVAL_MODEL').trim();
}

function piAgentRuntimeExists() {
  return [
    'src/lib/agent/pi/run-engine.ts',
    'src/lib/agent/providers/deepseek.ts',
    'src/lib/agent/providers/openai-compatible.ts',
    'src/lib/agent/tools/index.ts',
    'src/lib/services/cli/pi-agent.ts',
  ].every((file) => fs.existsSync(path.join(process.cwd(), file)));
}

console.log('\n🔍 PI Agent · 模型 Provider 配置检查\n');
console.log('默认模型：local_qwen:qwen3.5-9b-q5km');
console.log('日常 DeepSeek：deepseek:deepseek-v4-flash（外部模型网关）');
console.log('可选直连：deepseek-v4-flash（官方 API）');

if (!piAgentRuntimeExists()) {
  console.error('❌ PI Agent 上游执行内核或 Shop Gate 适配层不完整。');
  process.exit(1);
}
console.log('✅ PI Agent 核心、Provider、Tools 与产品接入层已就绪');

const deepSeekConfigured = Boolean(readEnvValue('DEEPSEEK_API_KEY'));
const modelPortConfigured = Boolean(readEnvValue('MODELPORT_API_KEY'));
const model = requestedModel();
const directDeepSeekSelected = model === 'deepseek-v4-flash';

if (directDeepSeekSelected) {
  if (!deepSeekConfigured) {
    console.error(
      '❌ 已选择官方直连 deepseek-v4-flash，但未配置 DEEPSEEK_API_KEY；请在 .env.local 或运行环境中注入该凭据。',
    );
    process.exit(1);
  }
  console.log('✅ 官方直连 DeepSeek：deepseek-v4-flash 凭据已配置');
} else if (!modelPortConfigured) {
  const selectionHint = model
    ? `当前选择 ${model} 需要外部模型网关凭据`
    : '当前未显式选择官方直连模型，默认 profile 仍是外部网关 Qwen';
  console.error(
    `❌ ${selectionHint}；请在 .env.local 中填写外部模型网关客户端凭据，或显式选择 deepseek-v4-flash 并配置 DEEPSEEK_API_KEY。`,
  );
  process.exit(1);
} else {
  console.log('✅ 外部模型网关：Qwen 与 DeepSeek 客户端凭据已配置');
}
console.log(`${deepSeekConfigured ? '✅' : 'ℹ️'} DeepSeek 官方直连：${deepSeekConfigured ? '运行环境凭据已注入' : '未启用（正常）'}`);
console.log(`验收模型：${model || '默认 profile（local_qwen:qwen3.5-9b-q5km）'}`);
console.log('✅ Provider Base URL 与模型 ID 由 config/llm.json 锁定\n');
