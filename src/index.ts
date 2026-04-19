import * as core from '@actions/core';
import * as github from '@actions/github';
import Anthropic from '@anthropic-ai/sdk';
import { parseSpec } from './parser/spec-parser.js';
import { parseIssue } from './parser/issue-parser.js';
import { checkSubscription } from './auth/subscription-check.js';
import { fetchSkills } from './auth/skill-fetcher.js';
import { orchestrateFromSpec, orchestrateFromIssue } from './agents/orchestrator.js';
import { runCodingAgent } from './agents/coding-agent.js';
import { runSentinel } from './agents/sentinel.js';
import { runNemesis } from './agents/nemesis.js';
import { updateReadme } from './updater/readme-updater.js';
import { buildChangelogEntry, updateChangelog } from './updater/changelog-updater.js';
import {
  createPullRequest,
  buildPrBody,
} from './github/pr-creator.js';
import {
  getIssueContext,
  commentOnIssue,
  buildVetoComment,
  getExistingFiles,
  getCurrentFile,
} from './github/issue-handler.js';

async function run(): Promise<void> {
  try {
    const anthropicKey = core.getInput('anthropic_api_key', { required: true });
    const daidalosToken = core.getInput('daidalos_token', { required: true });
    const githubToken = core.getInput('github_token', { required: false }) || process.env.GITHUB_TOKEN || '';

    core.info('Daidalos を起動しています...');

    const subResult = await checkSubscription(daidalosToken);
    if (!subResult.valid) {
      core.setFailed(`サブスク認証に失敗しました: ${subResult.error}`);
      return;
    }

    core.info(`サブスク認証OK (プラン: ${subResult.plan})`);

    const skills = await fetchSkills(daidalosToken);
    const client = new Anthropic({ apiKey: anthropicKey });

    const eventName = github.context.eventName;
    core.info(`トリガーイベント: ${eventName}`);

    if (eventName === 'push') {
      await handleSpecPush(client, skills, githubToken);
    } else if (eventName === 'issues') {
      await handleIssue(client, skills, githubToken);
    } else {
      core.warning(`未対応のイベント: ${eventName}`);
    }
  } catch (error) {
    core.setFailed(`Daidalos エラー: ${(error as Error).message}`);
  }
}

async function handleSpecPush(
  client: Anthropic,
  skills: ReturnType<typeof fetchSkills> extends Promise<infer T> ? T : never,
  githubToken: string
): Promise<void> {
  core.info('spec.yml トリガー: パイプラインを開始します...');

  const octokit = github.getOctokit(githubToken);
  const { owner, repo } = github.context.repo;

  let specContent: string;
  try {
    const content = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.daidalos/spec.yml',
    });
    if (Array.isArray(content.data) || !('content' in content.data)) {
      core.setFailed('.daidalos/spec.yml が見つかりません');
      return;
    }
    specContent = Buffer.from(content.data.content, 'base64').toString('utf-8');
  } catch (e) {
    core.setFailed(`.daidalos/spec.yml の読み込みに失敗しました: ${(e as Error).message}`);
    return;
  }

  let spec;
  try {
    spec = parseSpec(specContent);
  } catch (e) {
    core.setFailed(`spec.yml のバリデーションエラー: ${(e as Error).message}`);
    return;
  }

  core.info(`プロジェクト: ${spec.daidalos.project}`);

  const orchestratorResult = await orchestrateFromSpec(spec, skills, client);
  core.info(`タスク数: ${orchestratorResult.tasks.length}`);

  const existingFiles = await getExistingFiles(githubToken);
  const codingResult = await runCodingAgent(
    orchestratorResult.tasks,
    { spec, existingFiles },
    skills,
    client
  );

  if (spec.agents.security_review) {
    const sentinelResult = await runSentinel(codingResult.files, spec, skills, client);
    if (!sentinelResult.passed) {
      core.setFailed('Sentinel: セキュリティ上の問題が検出されました。PRの作成をブロックしました');
      return;
    }
  }

  let nemesisResult;
  if (spec.agents.test_generation) {
    nemesisResult = await runNemesis(codingResult.files, { spec }, skills, client);
    if (!nemesisResult.passed) {
      core.setFailed('Nemesis: テストが失敗しました。PRの作成をブロックしました');
      return;
    }
  }

  const currentReadme = await getCurrentFile('README.md', githubToken);
  const currentChangelog = await getCurrentFile('CHANGELOG.md', githubToken);

  const changelogEntry = buildChangelogEntry({
    summary: orchestratorResult.summary,
    files: codingResult.files,
    nemesisResult: nemesisResult ?? { passed: true, results: [], generatedTests: '', summary: '' },
  });

  const { readmeEntries, changelogContent } = updateChangelog(currentChangelog, changelogEntry);

  const readmeResult = await updateReadme(
    currentReadme,
    {
      spec,
      orchestratorResult,
      generatedFiles: codingResult.files,
      recentChangelogs: readmeEntries,
    },
    client
  );

  const branchName = `daidalos/${spec.daidalos.project}-${Date.now()}`;
  const baseBranch = github.context.ref.replace('refs/heads/', '');

  const sentinelResultForPr = spec.agents.security_review
    ? await runSentinel(codingResult.files, spec, skills, client)
    : { passed: true, issues: [], summary: 'スキップ' };

  const prBody = buildPrBody({
    summary: orchestratorResult.summary,
    sentinelResult: sentinelResultForPr,
    nemesisResult: nemesisResult ?? { passed: true, results: [], generatedTests: '', summary: '' },
    generatedFiles: codingResult.files,
  });

  const prResult = await createPullRequest(
    {
      title: `[Daidalos] ${spec.daidalos.project}: ${orchestratorResult.summary.slice(0, 60)}`,
      body: prBody,
      branchName,
      baseBranch,
      files: codingResult.files,
      readmeContent: readmeResult.changed ? readmeResult.content : undefined,
      changelogContent,
    },
    githubToken
  );

  core.setOutput('pr_url', prResult.prUrl);
  core.setOutput('status', 'success');
  core.info(`✅ PR作成完了: ${prResult.prUrl}`);
}

async function handleIssue(
  client: Anthropic,
  skills: ReturnType<typeof fetchSkills> extends Promise<infer T> ? T : never,
  githubToken: string
): Promise<void> {
  core.info('Issue トリガー: パイプラインを開始します...');

  const issueContext = await getIssueContext(githubToken);
  if (!issueContext) {
    core.info('Issue コンテキストが取得できませんでした');
    return;
  }

  const issueContent = issueContext.issueYmlContent ?? issueContext.issueBody;
  if (!issueContent) {
    await commentOnIssue(
      issueContext.issueNumber,
      '## ⚠️ Daidalos\n\n`.daidalos/issue.yml` またはIssueのbodyにYAML形式の指示を記述してください。',
      githubToken
    );
    return;
  }

  let issue;
  try {
    issue = parseIssue(issueContent);
  } catch (e) {
    await commentOnIssue(
      issueContext.issueNumber,
      `## ⚠️ Daidalos: issue.yml のバリデーションエラー\n\n\`\`\`\n${(e as Error).message}\n\`\`\``,
      githubToken
    );
    core.setFailed(`issue.yml のバリデーションエラー: ${(e as Error).message}`);
    return;
  }

  const existingFiles = await getExistingFiles(githubToken);
  const orchestratorResult = await orchestrateFromIssue(
    issue,
    Object.keys(existingFiles),
    skills,
    client
  );

  const codingResult = await runCodingAgent(
    orchestratorResult.tasks,
    { issue, existingFiles },
    skills,
    client
  );

  const sentinelResult = await runSentinel(codingResult.files, undefined, skills, client);
  if (!sentinelResult.passed) {
    await commentOnIssue(
      issueContext.issueNumber,
      buildVetoComment({ issue, sentinelResult }),
      githubToken
    );
    core.setFailed('Sentinel: セキュリティ上の問題が検出されました');
    return;
  }

  const nemesisResult = await runNemesis(codingResult.files, { issue }, skills, client);
  if (!nemesisResult.passed) {
    await commentOnIssue(
      issueContext.issueNumber,
      buildVetoComment({ issue, nemesisResult }),
      githubToken
    );
    core.setFailed('Nemesis: テストが失敗しました');
    return;
  }

  const currentReadme = await getCurrentFile('README.md', githubToken);
  const currentChangelog = await getCurrentFile('CHANGELOG.md', githubToken);

  const changelogEntry = buildChangelogEntry({
    issue,
    summary: orchestratorResult.summary,
    files: codingResult.files,
    nemesisResult,
  });

  const { readmeEntries, changelogContent } = updateChangelog(currentChangelog, changelogEntry);

  const readmeResult = await updateReadme(
    currentReadme,
    {
      issue,
      orchestratorResult,
      generatedFiles: codingResult.files,
      recentChangelogs: readmeEntries,
    },
    client
  );

  const branchName = `daidalos/issue-${issueContext.issueNumber}-${Date.now()}`;
  const baseBranch = github.context.ref.replace('refs/heads/', '') || 'main';

  const prBody = buildPrBody({
    summary: orchestratorResult.summary,
    sentinelResult,
    nemesisResult,
    generatedFiles: codingResult.files,
  });

  const prResult = await createPullRequest(
    {
      title: `[Daidalos] #${issueContext.issueNumber}: ${orchestratorResult.summary.slice(0, 60)}`,
      body: prBody,
      branchName,
      baseBranch,
      files: codingResult.files,
      readmeContent: readmeResult.changed ? readmeResult.content : undefined,
      changelogContent,
    },
    githubToken
  );

  await commentOnIssue(
    issueContext.issueNumber,
    `## ✅ Daidalos: PRを作成しました\n\n${prResult.prUrl}`,
    githubToken
  );

  core.setOutput('pr_url', prResult.prUrl);
  core.setOutput('status', 'success');
  core.info(`✅ PR作成完了: ${prResult.prUrl}`);
}

run();
