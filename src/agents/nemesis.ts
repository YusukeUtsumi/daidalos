import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { GeneratedFile } from './coding-agent.js';
import { ParsedSpec } from '../parser/spec-parser.js';
import { ParsedIssue } from '../parser/issue-parser.js';
import { SkillSet } from '../auth/skill-fetcher.js';

export interface TestResult {
  condition: string;
  passed: boolean;
  detail: string;
}

export interface NemesisResult {
  passed: boolean;
  results: TestResult[];
  generatedTests: string;
  summary: string;
}

export async function runNemesis(
  files: GeneratedFile[],
  context: { spec?: ParsedSpec; issue?: ParsedIssue },
  skills: SkillSet,
  client: Anthropic
): Promise<NemesisResult> {
  core.info('Nemesis: テスト生成・実行を開始します...');

  const acceptance = deriveAcceptance(context);
  const fileContents = files
    .filter((f) => f.action !== 'delete')
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const prompt = `${skills.nemesis}

## 受け入れ条件（各条件に対してテストを生成・評価してください）
${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}

## 実装コード
${fileContents}

${context.spec ? `## スタック\n- 言語: ${context.spec.stack?.language ?? 'typescript'}\n- フレームワーク: ${context.spec.stack?.framework ?? '不明'}` : ''}

## 出力形式（JSONのみ）
{
  "passed": true,
  "results": [
    {
      "condition": "受け入れ条件の文",
      "passed": true,
      "detail": "テスト結果の詳細"
    }
  ],
  "generatedTests": "// 生成されたテストコード全体",
  "summary": "テスト結果の要約"
}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = extractText(response);
  const result = parseNemesisResponse(text);

  if (result.passed) {
    core.info(`Nemesis: 全テスト通過 (${result.results.length}件) ✓`);
  } else {
    const failed = result.results.filter((r) => !r.passed);
    core.error(`Nemesis: ${failed.length}/${result.results.length}件のテストが失敗しました`);
    for (const r of failed) {
      core.error(`  FAIL: ${r.condition}\n    ${r.detail}`);
    }
  }

  return result;
}

function deriveAcceptance(context: { spec?: ParsedSpec; issue?: ParsedIssue }): string[] {
  if (context.issue?.acceptance && context.issue.acceptance.length > 0) {
    return context.issue.acceptance;
  }

  if (context.spec) {
    return [
      '全エンドポイントが正常なリクエストに対して適切なレスポンスを返すこと',
      '認証が必要なエンドポイントで未認証リクエストに401が返ること',
      '不正な入力値に対して400エラーが返ること',
      'ヘルスチェックエンドポイント（/health）が200を返すこと',
    ];
  }

  return ['基本的な動作確認が通ること'];
}

function parseNemesisResponse(text: string): NemesisResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    core.warning('Nemesis: JSONレスポンスが見つかりません。安全のためvetoします');
    return {
      passed: false,
      results: [{ condition: 'レスポンス解析', passed: false, detail: 'Nemesisのレスポンス解析に失敗しました' }],
      generatedTests: '',
      summary: 'レスポンス解析エラー',
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as NemesisResult;
    const anyFailed = (parsed.results ?? []).some((r) => !r.passed);

    return {
      passed: parsed.passed && !anyFailed,
      results: parsed.results ?? [],
      generatedTests: parsed.generatedTests ?? '',
      summary: parsed.summary ?? '',
    };
  } catch {
    return {
      passed: false,
      results: [{ condition: 'レスポンス解析', passed: false, detail: 'Nemesisのレスポンス解析に失敗しました' }],
      generatedTests: '',
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
