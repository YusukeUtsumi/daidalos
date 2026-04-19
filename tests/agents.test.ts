import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildChangelogEntry, formatChangelogEntry, updateChangelog } from '../src/updater/changelog-updater';
import { buildPrBody } from '../src/github/pr-creator';
import { buildVetoComment } from '../src/github/issue-handler';
import type { GeneratedFile } from '../src/agents/coding-agent';
import type { NemesisResult } from '../src/agents/nemesis';
import type { SentinelResult } from '../src/agents/sentinel';
import type { ParsedIssue } from '../src/parser/issue-parser';

const mockFiles: GeneratedFile[] = [
  { path: 'src/auth/jwt.ts', content: '// jwt impl', action: 'modify' },
  { path: 'src/routes/todos.ts', content: '// todos', action: 'create' },
];

const mockNemesisPassed: NemesisResult = {
  passed: true,
  results: [
    { condition: '有効期限切れトークンで401が返ること', passed: true, detail: 'テスト通過' },
    { condition: '有効なトークンは引き続き通ること', passed: true, detail: 'テスト通過' },
  ],
  generatedTests: '// test code',
  summary: '全テスト通過',
};

const mockNemesisFailed: NemesisResult = {
  passed: false,
  results: [
    { condition: '有効期限切れトークンで401が返ること', passed: false, detail: '401ではなく200が返った' },
    { condition: '有効なトークンは引き続き通ること', passed: true, detail: 'テスト通過' },
  ],
  generatedTests: '',
  summary: '1件失敗',
};

const mockSentinelPassed: SentinelResult = {
  passed: true,
  issues: [],
  summary: '問題なし',
};

const mockSentinelFailed: SentinelResult = {
  passed: false,
  issues: [
    { file: 'src/auth/jwt.ts', line: 42, severity: 'critical', message: 'トークンがハードコードされています' },
  ],
  summary: '重大な問題あり',
};

const mockIssue: ParsedIssue = {
  daidalos_task: { type: 'fix', target: 'src/auth/jwt.ts' },
  description: 'JWTの有効期限チェックが機能していない',
  acceptance: ['有効期限切れトークンで401が返ること', '有効なトークンは引き続き通ること'],
};

describe('changelog-updater', () => {
  it('changelogエントリを正しくビルドできる', () => {
    const entry = buildChangelogEntry({
      issue: mockIssue,
      summary: 'JWT有効期限チェックを修正',
      files: mockFiles,
      nemesisResult: mockNemesisPassed,
    });

    expect(entry.type).toBe('バグ修正');
    expect(entry.summary).toBe('JWT有効期限チェックを修正');
    expect(entry.files).toContain('src/auth/jwt.ts');
    expect(entry.verification).toHaveLength(2);
    expect(entry.verification[0]).toContain('✓');
  });

  it('失敗したテストが✗で表示される', () => {
    const entry = buildChangelogEntry({
      issue: mockIssue,
      summary: 'テスト',
      files: mockFiles,
      nemesisResult: mockNemesisFailed,
    });

    expect(entry.verification.some((v) => v.includes('✗'))).toBe(true);
  });

  it('formatChangelogEntryが正しいMarkdownを生成する', () => {
    const entry = buildChangelogEntry({
      issue: mockIssue,
      summary: 'JWT有効期限チェックを修正',
      files: mockFiles,
      nemesisResult: mockNemesisPassed,
    });

    const formatted = formatChangelogEntry(entry);
    expect(formatted).toContain('### ');
    expect(formatted).toContain('バグ修正');
    expect(formatted).toContain('**変更箇所**');
    expect(formatted).toContain('**理由**');
    expect(formatted).toContain('**検証**');
  });

  it('updateChangelogが既存のchangelogに新エントリを追加する', () => {
    const existing = '# Changelog\n\n### 2024-01-01 — 旧エントリ: 旧い変更\n- **変更箇所**: `old.ts`\n- **理由**: 旧理由\n- **検証**:\n  ✓ 旧条件';
    const entry = buildChangelogEntry({
      summary: '新しい変更',
      files: mockFiles,
      nemesisResult: mockNemesisPassed,
    });

    const { changelogContent, readmeEntries } = updateChangelog(existing, entry);

    expect(changelogContent).toContain('新しい変更');
    expect(changelogContent).toContain('旧い変更');
    expect(readmeEntries.length).toBeLessThanOrEqual(5);
  });
});

describe('pr-creator', () => {
  it('PR本文にSentinel/Nemesis結果が含まれる（通過）', () => {
    const body = buildPrBody({
      summary: 'テスト実装',
      sentinelResult: mockSentinelPassed,
      nemesisResult: mockNemesisPassed,
      generatedFiles: mockFiles,
    });

    expect(body).toContain('Daidalos');
    expect(body).toContain('✅ 通過');
    expect(body).toContain('src/auth/jwt.ts');
  });

  it('PR本文に失敗情報が含まれる', () => {
    const body = buildPrBody({
      summary: 'テスト実装',
      sentinelResult: mockSentinelFailed,
      nemesisResult: mockNemesisFailed,
      generatedFiles: mockFiles,
    });

    expect(body).toContain('❌ 問題あり');
    expect(body).toContain('CRITICAL');
    expect(body).toContain('トークンがハードコードされています');
  });
});

describe('issue-handler', () => {
  it('vetoコメントにSentinel問題が含まれる', () => {
    const comment = buildVetoComment({
      issue: mockIssue,
      sentinelResult: mockSentinelFailed,
    });

    expect(comment).toContain('Daidalos');
    expect(comment).toContain('ブロック');
    expect(comment).toContain('CRITICAL');
    expect(comment).toContain('トークンがハードコードされています');
  });

  it('vetoコメントにNemesis失敗が含まれる', () => {
    const comment = buildVetoComment({
      issue: mockIssue,
      nemesisResult: mockNemesisFailed,
    });

    expect(comment).toContain('Nemesis');
    expect(comment).toContain('❌');
    expect(comment).toContain('401ではなく200が返った');
  });
});
