import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { ParsedSpec } from '../parser/spec-parser.js';
import { ParsedIssue } from '../parser/issue-parser.js';
import { SkillSet } from '../auth/skill-fetcher.js';

export interface SubTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  priority: number;
  securityConstraints: string[];
}

export interface OrchestratorResult {
  tasks: SubTask[];
  resolvedStack: {
    language: string;
    framework: string;
    database: string;
  };
  summary: string;
}

export async function orchestrateFromSpec(
  spec: ParsedSpec,
  skills: SkillSet,
  client: Anthropic
): Promise<OrchestratorResult> {
  core.info('Orchestrator: spec.yml からタスクを分解します...');

  const systemPrompt = skills.orchestrator;
  const userPrompt = buildSpecPrompt(spec);

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(response);
  return parseOrchestratorResponse(text, spec);
}

export async function orchestrateFromIssue(
  issue: ParsedIssue,
  existingFiles: string[],
  skills: SkillSet,
  client: Anthropic
): Promise<OrchestratorResult> {
  core.info('Orchestrator: issue.yml からタスクを分解します...');

  const systemPrompt = skills.orchestrator;
  const userPrompt = buildIssuePrompt(issue, existingFiles);

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(response);
  return parseOrchestratorResponse(text, undefined, issue);
}

function buildSpecPrompt(spec: ParsedSpec): string {
  return `以下のspec.ymlを分析して、実装タスクをJSONで返してください。

## プロジェクト
- name: ${spec.daidalos.project}

## Intent（実装すべき機能）
${spec.intent}

## Stack
${spec.stack ? JSON.stringify(spec.stack, null, 2) : '未指定（intentから推論してください）'}

## セキュリティ制約
${JSON.stringify(spec.constraints, null, 2)}

## 出力形式（JSONのみ）
{
  "resolvedStack": { "language": "...", "framework": "...", "database": "..." },
  "tasks": [
    {
      "id": "task-1",
      "title": "タスク名",
      "description": "実装内容の詳細",
      "files": ["src/path/to/file.ts"],
      "priority": 1,
      "securityConstraints": ["auth required", "input validation"]
    }
  ],
  "summary": "実装概要の1文"
}`;
}

function buildIssuePrompt(issue: ParsedIssue, existingFiles: string[]): string {
  return `以下のissue.ymlを分析して、修正タスクをJSONで返してください。

## タスク種別
${issue.daidalos_task.type}

## 対象ファイル
${issue.daidalos_task.target ?? '未指定（descriptionから推論してください）'}

## 説明
${issue.description}

## 受け入れ条件（Nemesisのテスト条件として使用）
${issue.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}

## 既存ファイル（参考）
${existingFiles.slice(0, 30).join('\n')}

## 出力形式（JSONのみ）
{
  "resolvedStack": { "language": "typescript", "framework": "既存に合わせる", "database": "既存に合わせる" },
  "tasks": [
    {
      "id": "task-1",
      "title": "タスク名",
      "description": "修正内容の詳細",
      "files": ["src/path/to/file.ts"],
      "priority": 1,
      "securityConstraints": ["auth required"]
    }
  ],
  "summary": "修正概要の1文"
}`;
}

function parseOrchestratorResponse(
  text: string,
  spec?: ParsedSpec,
  issue?: ParsedIssue
): OrchestratorResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    core.warning('Orchestrator: JSONレスポンスが見つかりません。フォールバックを使用します');
    return buildFallbackResult(spec, issue);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as OrchestratorResult;
    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      return buildFallbackResult(spec, issue);
    }
    return parsed;
  } catch {
    core.warning('Orchestrator: JSONパースに失敗しました。フォールバックを使用します');
    return buildFallbackResult(spec, issue);
  }
}

function buildFallbackResult(spec?: ParsedSpec, issue?: ParsedIssue): OrchestratorResult {
  const language = spec?.stack?.language ?? 'typescript';
  const framework = spec?.stack?.framework ?? 'unknown';
  const database = spec?.stack?.database ?? 'none';

  return {
    resolvedStack: { language, framework, database },
    tasks: [
      {
        id: 'task-1',
        title: issue ? issue.daidalos_task.type : 'Implementation',
        description: issue ? issue.description : (spec?.intent ?? ''),
        files: issue?.daidalos_task.target ? [issue.daidalos_task.target] : [],
        priority: 1,
        securityConstraints: ['auth required', 'input validation'],
      },
    ],
    summary: issue ? `${issue.daidalos_task.type}: ${issue.description.slice(0, 80)}` : (spec?.intent.slice(0, 80) ?? ''),
  };
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}
