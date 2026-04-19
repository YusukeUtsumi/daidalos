import { ParsedIssue, IssueType } from '../parser/issue-parser.js';
import { NemesisResult } from '../agents/nemesis.js';
import { GeneratedFile } from '../agents/coding-agent.js';

const TYPE_LABELS: Record<IssueType, string> = {
  fix: 'バグ修正',
  feature: '新機能',
  refactor: 'リファクタリング',
  security: 'セキュリティ対応',
  docs: 'ドキュメント更新',
};

export interface ChangelogEntry {
  date: string;
  type: string;
  summary: string;
  files: string[];
  reason: string;
  verification: string[];
}

export interface ChangelogUpdateResult {
  readmeEntries: string[];
  changelogContent: string;
}

export function buildChangelogEntry(context: {
  issue?: ParsedIssue;
  summary: string;
  files: GeneratedFile[];
  nemesisResult: NemesisResult;
}): ChangelogEntry {
  const { issue, summary, files, nemesisResult } = context;

  const date = new Date().toISOString().split('T')[0];
  const type = issue ? TYPE_LABELS[issue.daidalos_task.type] : '実装';

  const verification = (nemesisResult.results ?? []).map(
    (r) => `- ${r.passed ? '✓' : '✗'} ${r.condition}`
  );

  return {
    date,
    type,
    summary,
    files: files.map((f) => f.path),
    reason: issue?.description ?? summary,
    verification,
  };
}

export function formatChangelogEntry(entry: ChangelogEntry): string {
  const lines: string[] = [
    `### ${entry.date} — ${entry.type}: ${entry.summary}`,
    `- **変更箇所**: ${entry.files.map((f) => `\`${f}\``).join(', ')}`,
    `- **理由**: ${entry.reason}`,
    '- **検証**:',
    ...entry.verification.map((v) => `  ${v}`),
  ];

  return lines.join('\n');
}

export function updateChangelog(
  currentChangelog: string,
  newEntry: ChangelogEntry
): ChangelogUpdateResult {
  const formatted = formatChangelogEntry(newEntry);

  const header = '# Changelog\n\n';
  const existingContent = currentChangelog.startsWith('# Changelog')
    ? currentChangelog.slice('# Changelog'.length).trimStart()
    : currentChangelog;

  const allEntries = [formatted, ...parseExistingEntries(existingContent)];

  const readmeEntries = allEntries.slice(0, 5);
  const changelogEntries = allEntries;

  const changelogContent = `${header}${changelogEntries.join('\n\n---\n\n')}\n`;

  return {
    readmeEntries,
    changelogContent,
  };
}

function parseExistingEntries(content: string): string[] {
  return content
    .split(/\n---\n/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}
