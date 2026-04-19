import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { ParsedSpec } from '../parser/spec-parser.js';
import { ParsedIssue } from '../parser/issue-parser.js';
import { SubTask } from './orchestrator.js';
import { SkillSet } from '../auth/skill-fetcher.js';

export interface GeneratedFile {
  path: string;
  content: string;
  action: 'create' | 'modify' | 'delete';
}

export interface CodingAgentResult {
  files: GeneratedFile[];
  summary: string;
}

export async function runCodingAgent(
  tasks: SubTask[],
  context: { spec?: ParsedSpec; issue?: ParsedIssue; existingFiles?: Record<string, string> },
  skills: SkillSet,
  client: Anthropic
): Promise<CodingAgentResult> {
  core.info(`Coding Agent: ${tasks.length}件のタスクを処理します...`);

  const allFiles: GeneratedFile[] = [];

  for (const task of tasks) {
    core.info(`  タスク処理中: ${task.title}`);
    const result = await processTask(task, context, skills, client);
    allFiles.push(...result);
  }

  return {
    files: deduplicateFiles(allFiles),
    summary: `${allFiles.length}ファイルを生成・更新しました`,
  };
}

async function processTask(
  task: SubTask,
  context: { spec?: ParsedSpec; issue?: ParsedIssue; existingFiles?: Record<string, string> },
  skills: SkillSet,
  client: Anthropic
): Promise<GeneratedFile[]> {
  const existingContent = task.files
    .filter((f) => context.existingFiles?.[f])
    .map((f) => `### ${f}\n\`\`\`\n${context.existingFiles![f]}\n\`\`\``)
    .join('\n\n');

  const constraints = context.spec?.constraints;
  const publicAllowed = constraints?.auth.public_allowed ?? ['/health', '/ping'];

  const prompt = `${skills.coding_agent}

## タスク
${task.description}

## 対象ファイル
${task.files.join(', ')}

## 制約
- 認証が不要なエンドポイント: ${publicAllowed.join(', ')} のみ
- セキュリティ要件: ${task.securityConstraints.join(', ')}
${context.spec ? `- 言語: ${context.spec.stack?.language ?? 'typescript'}` : ''}
${context.spec ? `- フレームワーク: ${context.spec.stack?.framework ?? '適切なもの'}` : ''}
${context.spec ? `- データベース: ${context.spec.stack?.database ?? 'none'}` : ''}

${context.issue ? `## 受け入れ条件\n${context.issue.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : ''}

${existingContent ? `## 既存コード\n${existingContent}` : ''}

## 出力形式（JSONのみ）
{
  "files": [
    {
      "path": "src/path/to/file.ts",
      "action": "create",
      "content": "// ファイルの内容"
    }
  ]
}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = extractText(response);
  return parseFilesFromResponse(text);
}

function parseFilesFromResponse(text: string): GeneratedFile[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    core.warning('Coding Agent: JSONレスポンスが見つかりません');
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { files: GeneratedFile[] };
    if (!Array.isArray(parsed.files)) return [];

    return parsed.files.filter(
      (f) => f.path && f.content && ['create', 'modify', 'delete'].includes(f.action)
    );
  } catch {
    core.warning('Coding Agent: JSONパースに失敗しました');
    return [];
  }
}

function deduplicateFiles(files: GeneratedFile[]): GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) {
    seen.set(file.path, file);
  }
  return Array.from(seen.values());
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}
