import * as core from '@actions/core';
import * as github from '@actions/github';
import { ParsedIssue } from '../parser/issue-parser.js';
import { SentinelResult } from '../agents/sentinel.js';
import { NemesisResult } from '../agents/nemesis.js';

export interface IssueContext {
  issueNumber: number;
  issueBody: string;
  hasIssueYml: boolean;
  issueYmlContent?: string;
}

export async function getIssueContext(token: string): Promise<IssueContext | null> {
  const { eventName, payload } = github.context;

  if (eventName !== 'issues') return null;

  const issue = payload.issue as { number: number; body: string } | undefined;
  if (!issue) return null;

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  let issueYmlContent: string | undefined;
  let hasIssueYml = false;

  try {
    const content = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.daidalos/issue.yml',
    });

    if (!Array.isArray(content.data) && 'content' in content.data) {
      issueYmlContent = Buffer.from(content.data.content, 'base64').toString('utf-8');
      hasIssueYml = true;
    }
  } catch {
    core.info('.daidalos/issue.yml が見つかりません。Issueのbodyを使用します');
  }

  return {
    issueNumber: issue.number,
    issueBody: issue.body ?? '',
    hasIssueYml,
    issueYmlContent,
  };
}

export async function commentOnIssue(
  issueNumber: number,
  body: string,
  token: string
): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

export function buildVetoComment(context: {
  issue: ParsedIssue;
  sentinelResult?: SentinelResult;
  nemesisResult?: NemesisResult;
  errorMessage?: string;
}): string {
  const { sentinelResult, nemesisResult, errorMessage } = context;

  const lines: string[] = ['## 🚫 Daidalos: PR作成をブロックしました\n'];

  if (errorMessage) {
    lines.push(`**エラー**: ${errorMessage}\n`);
  }

  if (sentinelResult && !sentinelResult.passed) {
    lines.push('### Sentinel（セキュリティレビュー）が問題を検出しました\n');
    for (const issue of sentinelResult.issues) {
      lines.push(`- [${issue.severity.toUpperCase()}] \`${issue.file}\`: ${issue.message}`);
    }
    lines.push('');
  }

  if (nemesisResult && !nemesisResult.passed) {
    lines.push('### Nemesis（テスト）が失敗しました\n');
    for (const r of nemesisResult.results.filter((r) => !r.passed)) {
      lines.push(`- ❌ ${r.condition}: ${r.detail}`);
    }
    lines.push('');
  }

  lines.push('> 問題を修正してから再度 `daidalos` ラベルを付け直してください。');

  return lines.join('\n');
}

export async function getExistingFiles(token: string): Promise<Record<string, string>> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const files: Record<string, string> = {};

  try {
    const tree = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: 'HEAD',
      recursive: 'true',
    });

    const tsFiles = tree.data.tree
      .filter((f) => f.type === 'blob' && f.path?.match(/\.(ts|js|py|go|rs)$/))
      .slice(0, 50);

    await Promise.all(
      tsFiles.map(async (f) => {
        if (!f.path) return;
        try {
          const content = await octokit.rest.repos.getContent({ owner, repo, path: f.path });
          if (!Array.isArray(content.data) && 'content' in content.data) {
            files[f.path] = Buffer.from(content.data.content, 'base64').toString('utf-8');
          }
        } catch {
          // 個別ファイルのfetch失敗は無視
        }
      })
    );
  } catch (e) {
    core.warning(`既存ファイルの取得に失敗しました: ${(e as Error).message}`);
  }

  return files;
}

export async function getCurrentFile(path: string, token: string): Promise<string> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    const content = await octokit.rest.repos.getContent({ owner, repo, path });
    if (!Array.isArray(content.data) && 'content' in content.data) {
      return Buffer.from(content.data.content, 'base64').toString('utf-8');
    }
  } catch {
    // ファイルが存在しない場合は空文字を返す
  }

  return '';
}
