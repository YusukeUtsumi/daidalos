import * as yaml from 'js-yaml';

export type IssueType = 'fix' | 'feature' | 'refactor' | 'security' | 'docs';

export interface ParsedIssue {
  daidalos_task: {
    type: IssueType;
    target?: string;
  };
  description: string;
  acceptance: string[];
}

const VALID_TYPES: IssueType[] = ['fix', 'feature', 'refactor', 'security', 'docs'];

const AMBIGUOUS_ACCEPTANCE_PATTERNS = [
  /^ちゃんと動くこと$/,
  /^正しく動作すること$/,
  /^うまくいくこと$/,
  /^テストが通ること$/,
];

export class IssueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueParseError';
  }
}

export function parseIssue(content: string): ParsedIssue {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (e) {
    throw new IssueParseError(`issue.yml のYAMLパースに失敗しました: ${(e as Error).message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new IssueParseError('issue.yml が空またはオブジェクト形式ではありません');
  }

  const doc = raw as Record<string, unknown>;

  if (!doc.daidalos_task || typeof doc.daidalos_task !== 'object') {
    throw new IssueParseError('daidalos_task フィールドが必要です');
  }

  const task = doc.daidalos_task as Record<string, unknown>;

  if (!task.type || !VALID_TYPES.includes(task.type as IssueType)) {
    throw new IssueParseError(
      `daidalos_task.type は必須です。有効な値: ${VALID_TYPES.join(', ')}`
    );
  }

  if (!doc.description || typeof doc.description !== 'string') {
    throw new IssueParseError('description フィールドは必須です');
  }

  const description = doc.description.trim();
  if (description.length === 0) {
    throw new IssueParseError('description が空です');
  }

  if (!doc.acceptance || !Array.isArray(doc.acceptance)) {
    throw new IssueParseError('acceptance フィールドは必須の配列です');
  }

  const acceptance = doc.acceptance as unknown[];

  if (acceptance.length === 0) {
    throw new IssueParseError('acceptance には少なくとも1つの条件が必要です');
  }

  const validatedAcceptance: string[] = [];
  for (const item of acceptance) {
    if (typeof item !== 'string') {
      throw new IssueParseError('acceptance の各条件は文字列でなければなりません');
    }

    const trimmed = item.trim();

    for (const pattern of AMBIGUOUS_ACCEPTANCE_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new IssueParseError(
          `acceptance の条件が曖昧すぎます: "${trimmed}"\n` +
            '動作・HTTPステータス・状態変化が確認できるレベルで記述してください'
        );
      }
    }

    validatedAcceptance.push(trimmed);
  }

  return {
    daidalos_task: {
      type: task.type as IssueType,
      target: typeof task.target === 'string' ? task.target : undefined,
    },
    description,
    acceptance: validatedAcceptance,
  };
}
