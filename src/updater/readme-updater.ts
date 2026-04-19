import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { ParsedSpec } from '../parser/spec-parser.js';
import { ParsedIssue } from '../parser/issue-parser.js';
import { GeneratedFile } from '../agents/coding-agent.js';
import { OrchestratorResult } from '../agents/orchestrator.js';

const GENERATED_START = '<!-- daidalos:generated -->';
const GENERATED_END = '<!-- daidalos:end -->';

export interface ReadmeUpdateResult {
  content: string;
  changed: boolean;
}

export async function updateReadme(
  currentReadme: string,
  context: {
    spec?: ParsedSpec;
    issue?: ParsedIssue;
    orchestratorResult: OrchestratorResult;
    generatedFiles: GeneratedFile[];
    recentChangelogs: string[];
  },
  client: Anthropic
): Promise<ReadmeUpdateResult> {
  core.info('README updater: README.md を更新します...');

  const generatedBlock = await generateBlock(context, client);
  const newReadme = replaceGeneratedBlock(currentReadme, generatedBlock);

  return {
    content: newReadme,
    changed: newReadme !== currentReadme,
  };
}

async function generateBlock(
  context: {
    spec?: ParsedSpec;
    issue?: ParsedIssue;
    orchestratorResult: OrchestratorResult;
    generatedFiles: GeneratedFile[];
    recentChangelogs: string[];
  },
  client: Anthropic
): Promise<string> {
  const { spec, orchestratorResult, generatedFiles, recentChangelogs } = context;

  const prompt = `以下の情報をもとにREADMEの自動生成セクションをMarkdown形式で書いてください。
コードブロックや余分な前置き文は不要です。Markdownの内容だけを返してください。

## System Overview（intentとstackから生成）
- Intent: ${spec?.intent ?? orchestratorResult.summary}
- Stack: ${JSON.stringify(orchestratorResult.resolvedStack)}

## Architecture（構成・エンドポイント一覧）
生成されたファイル:
${generatedFiles.map((f) => `- ${f.path} (${f.action})`).join('\n')}

## Recent Changes（直近の変更）
${recentChangelogs.length > 0 ? recentChangelogs.slice(0, 5).join('\n\n') : '変更なし'}

---
出力例:
## System Overview
...

## Architecture
...

## Recent Changes
...
`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  for (const block of response.content) {
    if (block.type === 'text') return block.text.trim();
  }

  return buildStaticBlock(context);
}

function buildStaticBlock(context: {
  spec?: ParsedSpec;
  orchestratorResult: OrchestratorResult;
  generatedFiles: GeneratedFile[];
  recentChangelogs: string[];
}): string {
  const { spec, orchestratorResult, generatedFiles, recentChangelogs } = context;

  const lines: string[] = [
    '## System Overview',
    '',
    spec?.intent ?? orchestratorResult.summary,
    '',
    `**Stack**: ${orchestratorResult.resolvedStack.language} / ${orchestratorResult.resolvedStack.framework} / ${orchestratorResult.resolvedStack.database}`,
    '',
    '## Architecture',
    '',
    ...generatedFiles.map((f) => `- \`${f.path}\``),
    '',
    '## Recent Changes',
    '',
    ...(recentChangelogs.length > 0 ? recentChangelogs.slice(0, 5) : ['変更なし']),
  ];

  return lines.join('\n');
}

function replaceGeneratedBlock(readme: string, newBlock: string): string {
  const startIdx = readme.indexOf(GENERATED_START);
  const endIdx = readme.indexOf(GENERATED_END);

  const replacement = `${GENERATED_START}\n${newBlock}\n${GENERATED_END}`;

  if (startIdx === -1 || endIdx === -1) {
    return `${readme}\n\n${replacement}\n`;
  }

  return readme.slice(0, startIdx) + replacement + readme.slice(endIdx + GENERATED_END.length);
}
