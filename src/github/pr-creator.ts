import * as core from '@actions/core';
import * as github from '@actions/github';
import { GeneratedFile } from '../agents/coding-agent.js';
import { SentinelResult } from '../agents/sentinel.js';
import { NemesisResult } from '../agents/nemesis.js';

export interface PrCreatorOptions {
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  files: GeneratedFile[];
  readmeContent?: string;
  changelogContent?: string;
}

export interface PrCreatorResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

export async function createPullRequest(
  options: PrCreatorOptions,
  token: string
): Promise<PrCreatorResult> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  core.info(`PR作成: ブランチ "${options.branchName}" を作成します...`);

  const baseSha = await getBaseSha(octokit, owner, repo, options.baseBranch);
  await createBranch(octokit, owner, repo, options.branchName, baseSha);

  const allFiles: GeneratedFile[] = [...options.files];

  if (options.readmeContent) {
    allFiles.push({ path: 'README.md', content: options.readmeContent, action: 'modify' });
  }

  if (options.changelogContent) {
    allFiles.push({ path: 'CHANGELOG.md', content: options.changelogContent, action: 'modify' });
  }

  for (const file of allFiles) {
    if (file.action === 'delete') {
      await deleteFile(octokit, owner, repo, file.path, options.branchName);
    } else {
      await upsertFile(octokit, owner, repo, file.path, file.content, options.branchName);
    }
  }

  const pr = await octokit.rest.pulls.create({
    owner,
    repo,
    title: options.title,
    body: options.body,
    head: options.branchName,
    base: options.baseBranch,
  });

  core.info(`PR作成完了: ${pr.data.html_url}`);

  return {
    prUrl: pr.data.html_url,
    prNumber: pr.data.number,
    branchName: options.branchName,
  };
}

export function buildPrBody(context: {
  summary: string;
  sentinelResult: SentinelResult;
  nemesisResult: NemesisResult;
  generatedFiles: GeneratedFile[];
}): string {
  const { summary, sentinelResult, nemesisResult, generatedFiles } = context;

  const sentinelStatus = sentinelResult.passed ? '✅ 通過' : '❌ 問題あり';
  const nemesisStatus = nemesisResult.passed ? '✅ 通過' : '❌ 失敗あり';

  const sentinelIssues = sentinelResult.issues.length > 0
    ? sentinelResult.issues.map((i) => `- [${i.severity.toUpperCase()}] \`${i.file}\`: ${i.message}`).join('\n')
    : '問題なし';

  const testResults = (nemesisResult.results ?? [])
    .map((r) => `- ${r.passed ? '✅' : '❌'} ${r.condition}`)
    .join('\n');

  const fileList = generatedFiles
    .map((f) => `- \`${f.path}\` (${f.action})`)
    .join('\n');

  return `## 🤖 Daidalos による自動生成PR

${summary}

---

## 変更ファイル

${fileList}

---

## Sentinel（セキュリティレビュー）: ${sentinelStatus}

${sentinelIssues}

---

## Nemesis（テスト結果）: ${nemesisStatus}

${testResults}

---

> このPRはDaidalosエージェントによって自動生成されました。
> マージ = 変更の承認という記録になります。`;
}

async function getBaseSha(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  const ref = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  return ref.data.object.sha;
}

async function createBranch(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  sha: string
): Promise<void> {
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
  } catch (e) {
    const err = e as { status?: number };
    if (err.status !== 422) throw e;
    core.info(`ブランチ "${branchName}" は既に存在します`);
  }
}

async function upsertFile(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  path: string,
  content: string,
  branch: string
): Promise<void> {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  let sha: string | undefined;

  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && 'sha' in existing.data) {
      sha = existing.data.sha;
    }
  } catch {
    // ファイルが存在しない場合は新規作成
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: `chore: [daidalos] update ${path}`,
    content: encoded,
    branch,
    sha,
  });
}

async function deleteFile(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<void> {
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && 'sha' in existing.data) {
      await octokit.rest.repos.deleteFile({
        owner,
        repo,
        path,
        message: `chore: [daidalos] delete ${path}`,
        sha: existing.data.sha,
        branch,
      });
    }
  } catch {
    core.warning(`削除対象ファイルが見つかりません: ${path}`);
  }
}
