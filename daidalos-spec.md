# Daidalos — Implementation Spec for ClaudeCode

## 概要

GitHubに寄生するマルチエージェント開発自動化ツール。
ユーザーが`.daidalos/spec.yml`に設計を書いてpushするだけで、エージェント群がシステムの構築・テスト・ドキュメント更新まで自律的に行う。

---

## アーキテクチャ全体像

```
[User Repository]
  .daidalos/
    spec.yml          # システム設計書（pushトリガー）
    issue.yml         # 修正指示テンプレート（issueトリガー）

  .github/
    workflows/
      daidalos.yml    # GitHub Actions ワークフロー

  README.md           # エージェントが自動更新
  CHANGELOG.md        # 全変更履歴（エージェントが自動更新）
```

```
トリガー① spec.ymlのpush
  └─ Orchestrator: spec.ymlをパース・タスク分解
        ├─ Coding Agent: コード生成
        ├─ Sentinel: セキュリティレビュー
        ├─ Nemesis: テスト実行・veto
        └─ PR作成（コード + README更新を含む）

トリガー② Issue作成 + "daidalos"ラベル
  └─ 同パイプライン（修正モード）
        └─ issue.ymlのacceptanceをNemesisのテスト条件として使用
```

---

## ディレクトリ構成（実装対象）

```
daidalos/                          # GitHub Actionのリポジトリ（OSS）
  action.yml                       # GitHub Action定義
  src/
    index.ts                       # エントリーポイント
    parser/
      spec-parser.ts               # spec.ymlのパース
      issue-parser.ts              # issue.ymlのパース
    agents/
      orchestrator.ts              # タスク分解・エージェント制御
      coding-agent.ts              # コード生成
      sentinel.ts                  # セキュリティレビュー
      nemesis.ts                   # テスト生成・実行・veto
    updater/
      readme-updater.ts            # README.mdの自動更新
      changelog-updater.ts         # CHANGELOG.mdの自動更新
    auth/
      subscription-check.ts        # サブスク認証（認証サーバーへのリクエスト）
      skill-fetcher.ts             # SKILL.md群のfetch（認証後）
    github/
      pr-creator.ts                # PR作成
      issue-handler.ts             # Issue検知・ラベル判定
  tests/
    parser.test.ts
    agents.test.ts
```

---

## spec.yml 仕様

### フィールド定義

```yaml
daidalos:
  version: "1.0"          # 必須。現在は"1.0"固定
  project: "project-name" # 必須。プロジェクト識別子

intent: |                 # 必須。自然言語でシステムの目的・機能を記述
  # 良い例: ユーザーが登録・ログインできるAPIサーバー。
  #         ログイン後はTodoリストを作成・編集・削除できる。
  # NG例:  APIを作りたい（曖昧すぎる→Orchestratorがエラーを返す）

stack:                    # 任意。省略時はintentからOrchestratorが推論
  language: typescript    # 例: typescript / python / go
  framework: hono         # 例: hono / express / fastapi
  database: postgresql    # 例: postgresql / mysql / sqlite / none

constraints:              # 任意。省略時はデフォルト値が自動適用
  overrides: {}           # 緩める場合のみ明示的に記述

agents:                   # 任意。デフォルトはすべてtrue
  security_review: true
  test_generation: true
```

### constraints デフォルト値（省略時に自動適用・上書き不可）

```yaml
defaults:
  auth:
    required: true
    public_allowed:
      - "/health"
      - "/ping"
  data:
    no_plaintext_secrets: true
    no_sensitive_logs: true
    input_validation: true
  external:
    no_direct_api_calls: true
    no_eval: true
  errors:
    no_stack_trace_exposure: true
```

### constraintsを緩める場合（overridesで明示的に上書き）

```yaml
constraints:
  overrides:
    auth:
      public_allowed:
        - "/health"
        - "/api/v1/public/*"
```

---

## issue.yml 仕様

### フィールド定義

```yaml
daidalos_task:
  type: fix               # 必須。fix / feature / refactor / security / docs
  target: "src/auth/jwt.ts" # 任意。省略時はdescriptionからOrchestratorが推論

description: |            # 必須。何が問題か・何をしたいかを自然言語で記述
  JWTの有効期限チェックが機能していない。
  ログイン後24時間経過しても認証が通り続ける。

acceptance:               # 必須。これがそのままNemesisのテスト条件になる
  - "有効期限切れトークンで401が返ること"
  - "有効なトークンは引き続き通ること"
```

### typeの種類

| type | 用途 | コード変更 |
|------|------|-----------|
| fix | バグ修正 | あり |
| feature | 新機能追加 | あり |
| refactor | リファクタリング | あり（動作変更なし） |
| security | セキュリティ対応 | あり |
| docs | ドキュメントのみ更新 | なし |

### acceptanceの粒度方針

- 動作・HTTPステータス・状態変化が確認できるレベルで書く
- これがそのままNemesisのテスト条件として使われる
- エンジニアが詳細に書いた場合はそれを優先・検証精度が上がる
- 「ちゃんと動くこと」のような曖昧な記述はOrchestratorがエラーを返す

---

## GitHub Actions ワークフロー定義

```yaml
# .github/workflows/daidalos.yml（ユーザーリポジトリに配置）

name: Daidalos

on:
  push:
    paths:
      - '.daidalos/spec.yml'
  issues:
    types: [labeled]

jobs:
  daidalos:
    runs-on: ubuntu-latest
    # 外部forkからのPRではSecretsが渡らない（セキュリティ担保）
    if: github.event_name == 'push' || (github.event_name == 'issues' && github.event.label.name == 'daidalos')
    steps:
      - uses: actions/checkout@v4
      - uses: meltlight/daidalos@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          daidalos_token: ${{ secrets.DAIDALOS_TOKEN }}  # サブスク認証トークン
```

---

## エージェント仕様

### Orchestrator

**役割**: spec.yml / issue.ymlをパースし、タスクを分解して各エージェントに指示を出す

**処理フロー（spec.ymlトリガー時）**:
1. spec.ymlをパース・バリデーション
2. intentが曖昧すぎる場合はエラーをPRコメントで返す
3. stackが省略されていればintentから推論して決定
4. タスクをサブタスクに分解
5. Coding Agentにコード生成を指示
6. Sentinelにレビューを指示
7. Nemesisにテストを指示
8. 全エージェントがpassしたらPRを作成

**処理フロー（issue.ymlトリガー時）**:
1. issue.ymlをパースして修正指示を取得
2. targetが省略されていればdescriptionから対象ファイルを推論
3. acceptanceをNemesisのテスト条件として渡す
4. 以降はspec.ymlトリガーと同様

---

### Coding Agent

**役割**: Orchestratorの指示に従ってコードを生成・修正する

**制約**:
- constraints（デフォルト + overrides）を常に参照してコードを生成
- 認証なしエンドポイントをpublic_allowed以外に作らない
- シークレットを平文でハードコードしない
- 全入力値にバリデーションを実装する
- evalや動的コード実行を使わない

---

### Sentinel

**役割**: 生成されたコードをセキュリティ観点で独立してレビューする

**チェック項目**:
- constraints違反がないか（Coding Agentとは独立してチェック）
- 認証バイパスの可能性がないか
- インジェクション脆弱性がないか
- シークレットの取り扱いに問題がないか
- スタックトレースがレスポンスに含まれていないか

**veto権**: 問題を検出した場合はPR作成をブロックし、指摘をコメントで返す

---

### Nemesis

**役割**: acceptanceに基づいてテストを生成・実行し、合否を判定する

**テスト生成の入力**:
- spec.ymlトリガー時: intentとstackから標準的なテストケースを生成
- issue.ymlトリガー時: acceptanceフィールドの各条件をテストケースに変換

**veto権**: テストが1件でも失敗した場合はPR作成をブロックする

---

## README自動更新仕様

### 更新ルール

- `<!-- daidalos:generated -->` と `<!-- daidalos:end -->` で囲まれたブロックのみ書き換える
- ユーザーが書いた部分（タグの外）は一切触らない
- PR作成時にコードの変更と同じPRにREADME更新を含める
- マージ = 変更の承認という記録になる

### READMEの自動生成ブロック

```markdown
<!-- daidalos:generated -->
## System Overview
（intentとstackから自動生成）

## Architecture
（構成・エンドポイント一覧を自動生成）

## Recent Changes
（直近5件のchangelogを表示）
<!-- daidalos:end -->
```

### CHANGELOG.mdへの移動ルール

- READMEには直近5件のchangelogのみ表示
- 6件目以降は`CHANGELOG.md`に自動移動
- CHANGELOG.mdが存在しない場合は自動作成

### changelogの書式

```markdown
### YYYY-MM-DD — [typeの日本語名]: [変更の要約]
- **変更箇所**: `ファイルパス`
- **理由**: descriptionの要約
- **検証**: acceptanceの各条件と合否（Nemesisによる）
```

---

## セキュリティ設計

### APIキーの管理フロー

```
ユーザーがGitHub SecretsにANTHROPIC_API_KEYを登録
  └─ GitHub Actions実行時にprocess.env.ANTHROPIC_API_KEYとして参照
        └─ DaidalosのコードがAnthropicAPIを呼び出す
              └─ MeltLightのサーバーにはキーが渡らない
```

### サブスク認証フロー

```
GitHub Actions起動
  └─ DAIDALOS_TOKENで認証サーバー（Vercel / Cloudflare Workers）にリクエスト
        └─ 有効なサブスクの場合: SKILL.md群を返す
        └─ 無効・期限切れの場合: 401を返しActionsを終了
```

### 外部forkからのキー窃取防止

- `pull_request`イベント（`pull_request_target`は使わない）
- 外部forkからのPRではGitHub SecretsがActionsに渡らない仕様を利用

---

## OSS / クローズドの境界

| 対象 | 公開方針 | 理由 |
|------|---------|------|
| Action Runner（action.yml + src/） | OSS | 信頼担保、採用障壁を下げる |
| エージェント連携構造 | OSS | コモディティ、隠す意味なし |
| GitHub Actions連携 | OSS | 同上 |
| README/CHANGELOG更新ロジック | OSS | 見せても差別化に影響なし |
| SKILL.md群 | クローズド | 差別化資産。認証サーバーから配信 |
| Orchestratorプロンプト | クローズド | 判断基準が内包されている |

---

## Phase 1 MVP スコープ

今回ClaudeCodeに実装してもらう範囲。

### 含むもの
- [ ] spec.ymlのパース・バリデーション
- [ ] issue.ymlのパース・バリデーション
- [ ] Orchestrator（タスク分解・エージェント制御）
- [ ] Coding Agent（コード生成）
- [ ] Sentinel（セキュリティレビュー）
- [ ] Nemesis（テスト生成・実行・veto）
- [ ] README自動更新
- [ ] CHANGELOG自動更新
- [ ] PR自動作成
- [ ] GitHub Actions ワークフロー定義
- [ ] サブスク認証（モック実装でOK、後で本物に差し替え）

### 含まないもの（Phase 2以降）
- WebUI（非エンジニア向け）
- 認証サーバーの本番実装
- GitHub Marketplace登録
- APIキー不要オプション

---

## 技術スタック（Action実装側）

- **言語**: TypeScript
- **ランタイム**: Node.js 20
- **主要ライブラリ**:
  - `@anthropic-ai/sdk`: Anthropic API呼び出し
  - `@actions/core`: GitHub Actions SDK
  - `@actions/github`: GitHub API操作
  - `js-yaml`: YAML파스
  - `vitest`: テスト

---

## 備考・実装上の注意

1. **intentのバリデーション**: 文字数が少なすぎる（20文字以下）または曖昧なキーワードのみの場合はOrchestratorがエラーを返してActionsを失敗させる

2. **SKILL.mdのモック**: Phase 1ではSKILL.mdのfetchをモックし、固定のプロンプトを使う。認証サーバーが完成したら差し替える

3. **PR作成の権限**: `GITHUB_TOKEN`の`pull-requests: write`と`contents: write`が必要。action.ymlに明記する

4. **Nemesisのテスト実行環境**: GitHub Actions内でdocker-composeを使ってDBを立ち上げてテストする想定

5. **エラーハンドリング**: どのエージェントがveto・エラーを出したかをPRコメントまたはIssueコメントで明示する
