import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { GeneratedFile } from './coding-agent.js';
import { SkillSet } from '../auth/skill-fetcher.js';
import { ParsedSpec } from '../parser/spec-parser.js';

export interface SentinelIssue {
  file: string;
  line?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

export interface SentinelResult {
  passed: boolean;
  issues: SentinelIssue[];
  summary: string;
}

export async function runSentinel(
  files: GeneratedFile[],
  spec: ParsedSpec | undefined,
  skills: SkillSet,
  client: Anthropic
): Promise<SentinelResult> {
  core.info('Sentinel: セキュリティレビューを開始します...');

  if (files.length === 0) {
    return { passed: true, issues: [], summary: 'レビュー対象ファイルなし' };
  }

  const fileContents = files
    .filter((f) => f.action !== 'delete')
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const publicAllowed = spec?.constraints.auth.public_allowed ?? ['/health', '/ping'];

  const prompt = `${skills.sentinel}

## レビュー対象コード
${fileContents}

## 認証が不要なエンドポイント（これ以外は認証必須）
${publicAllowed.join(', ')}

## セキュリティ制約
${spec ? JSON.stringify(spec.constraints, null, 2) : 'デフォルト制約を適用'}

## 出力形式（JSONのみ）
{
  "passed": true,
  "issues": [
    {
      "file": "src/path/to/file.ts",
      "line": 42,
      "severity": "critical",
      "message": "問題の説明"
    }
  ],
  "summary": "レビュー結果の要約"
}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = extractText(response);
  const result = parseSentinelResponse(text);

  if (result.passed) {
    core.info('Sentinel: セキュリティチェック通過 ✓');
  } else {
    core.error(`Sentinel: ${result.issues.length}件の問題を検出しました`);
    for (const issue of result.issues) {
      const loc = issue.line ? `:${issue.line}` : '';
      core.error(`  [${issue.severity.toUpperCase()}] ${issue.file}${loc} - ${issue.message}`);
    }
  }

  return result;
}

function parseSentinelResponse(text: string): SentinelResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    core.warning('Sentinel: JSONレスポンスが見つかりません。安全のためvetoします');
    return {
      passed: false,
      issues: [{ file: 'unknown', severity: 'critical', message: 'Sentinelのレスポンス解析に失敗しました' }],
      summary: 'レスポンス解析エラー',
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as SentinelResult;
    const criticalOrHigh = (parsed.issues ?? []).filter(
      (i) => i.severity === 'critical' || i.severity === 'high'
    );

    return {
      passed: parsed.passed && criticalOrHigh.length === 0,
      issues: parsed.issues ?? [],
      summary: parsed.summary ?? '',
    };
  } catch {
    return {
      passed: false,
      issues: [{ file: 'unknown', severity: 'critical', message: 'Sentinelのレスポンス解析に失敗しました' }],
      summary: 'レスポンス解析エラー',
    };
  }
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}
