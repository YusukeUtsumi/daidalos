import { describe, it, expect } from 'vitest';
import { parseSpec, SpecParseError } from '../src/parser/spec-parser';
import { parseIssue, IssueParseError } from '../src/parser/issue-parser';

describe('spec-parser', () => {
  const validSpec = `
daidalos:
  version: "1.0"
  project: "my-todo-api"

intent: |
  ユーザーが登録・ログインできるAPIサーバー。
  ログイン後はTodoリストを作成・編集・削除できる。

stack:
  language: typescript
  framework: hono
  database: postgresql
`;

  it('有効なspec.ymlをパースできる', () => {
    const result = parseSpec(validSpec);
    expect(result.daidalos.project).toBe('my-todo-api');
    expect(result.daidalos.version).toBe('1.0');
    expect(result.stack?.language).toBe('typescript');
    expect(result.stack?.framework).toBe('hono');
    expect(result.agents.security_review).toBe(true);
    expect(result.agents.test_generation).toBe(true);
  });

  it('デフォルトのconstraintsが適用される', () => {
    const result = parseSpec(validSpec);
    expect(result.constraints.auth.required).toBe(true);
    expect(result.constraints.auth.public_allowed).toContain('/health');
    expect(result.constraints.data.no_plaintext_secrets).toBe(true);
    expect(result.constraints.errors.no_stack_trace_exposure).toBe(true);
  });

  it('public_allowedのオーバーライドが適用される', () => {
    const spec = `
daidalos:
  version: "1.0"
  project: "test"

intent: |
  ユーザーが登録・ログインできるAPIサーバー。
  ログイン後はTodoリストを作成・編集・削除できる。

constraints:
  overrides:
    auth:
      public_allowed:
        - "/health"
        - "/api/v1/public/*"
`;
    const result = parseSpec(spec);
    expect(result.constraints.auth.public_allowed).toContain('/api/v1/public/*');
  });

  it('stackが省略された場合undefinedになる', () => {
    const spec = `
daidalos:
  version: "1.0"
  project: "test"

intent: |
  ユーザーが登録・ログインできるAPIサーバー。
  ログイン後はTodoリストを作成・編集・削除できる。
`;
    const result = parseSpec(spec);
    expect(result.stack).toBeUndefined();
  });

  it('agentsフィールドで個別に無効化できる', () => {
    const spec = `
daidalos:
  version: "1.0"
  project: "test"

intent: |
  ユーザーが登録・ログインできるAPIサーバー。
  ログイン後はTodoリストを作成・編集・削除できる。

agents:
  security_review: false
  test_generation: true
`;
    const result = parseSpec(spec);
    expect(result.agents.security_review).toBe(false);
    expect(result.agents.test_generation).toBe(true);
  });

  it('daidalosフィールドがない場合エラー', () => {
    expect(() => parseSpec('intent: test')).toThrow(SpecParseError);
  });

  it('versionが1.0以外の場合エラー', () => {
    const spec = `
daidalos:
  version: "2.0"
  project: "test"
intent: test
`;
    expect(() => parseSpec(spec)).toThrow(SpecParseError);
  });

  it('intentが20文字以下の場合エラー', () => {
    const spec = `
daidalos:
  version: "1.0"
  project: "test"
intent: "短すぎる"
`;
    expect(() => parseSpec(spec)).toThrow(SpecParseError);
  });

  it('不正なYAMLはパースエラー', () => {
    expect(() => parseSpec('{')).toThrow(SpecParseError);
  });
});

describe('issue-parser', () => {
  const validIssue = `
daidalos_task:
  type: fix
  target: "src/auth/jwt.ts"

description: |
  JWTの有効期限チェックが機能していない。
  ログイン後24時間経過しても認証が通り続ける。

acceptance:
  - "有効期限切れトークンで401が返ること"
  - "有効なトークンは引き続き通ること"
`;

  it('有効なissue.ymlをパースできる', () => {
    const result = parseIssue(validIssue);
    expect(result.daidalos_task.type).toBe('fix');
    expect(result.daidalos_task.target).toBe('src/auth/jwt.ts');
    expect(result.acceptance).toHaveLength(2);
    expect(result.acceptance[0]).toBe('有効期限切れトークンで401が返ること');
  });

  it('targetが省略可能', () => {
    const issue = `
daidalos_task:
  type: feature

description: |
  新しい機能を追加する。
  詳細な説明がここに入る。

acceptance:
  - "機能が正常に動作すること（詳細条件）"
`;
    const result = parseIssue(issue);
    expect(result.daidalos_task.target).toBeUndefined();
  });

  it('全typeが有効', () => {
    for (const type of ['fix', 'feature', 'refactor', 'security', 'docs']) {
      const issue = `
daidalos_task:
  type: ${type}

description: |
  十分な長さの説明文がここに入ります。

acceptance:
  - "具体的な受け入れ条件がここに入る"
`;
      const result = parseIssue(issue);
      expect(result.daidalos_task.type).toBe(type);
    }
  });

  it('無効なtypeはエラー', () => {
    const issue = `
daidalos_task:
  type: invalid

description: test

acceptance:
  - "条件"
`;
    expect(() => parseIssue(issue)).toThrow(IssueParseError);
  });

  it('acceptanceが空配列の場合エラー', () => {
    const issue = `
daidalos_task:
  type: fix

description: |
  十分な長さの説明文

acceptance: []
`;
    expect(() => parseIssue(issue)).toThrow(IssueParseError);
  });

  it('曖昧なacceptanceはエラー', () => {
    const issue = `
daidalos_task:
  type: fix

description: |
  十分な長さの説明文

acceptance:
  - "ちゃんと動くこと"
`;
    expect(() => parseIssue(issue)).toThrow(IssueParseError);
  });

  it('acceptanceがない場合エラー', () => {
    const issue = `
daidalos_task:
  type: fix

description: |
  十分な長さの説明文
`;
    expect(() => parseIssue(issue)).toThrow(IssueParseError);
  });
});
