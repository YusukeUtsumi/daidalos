import * as yaml from 'js-yaml';

export interface SpecConstraintDefaults {
  auth: {
    required: boolean;
    public_allowed: string[];
  };
  data: {
    no_plaintext_secrets: boolean;
    no_sensitive_logs: boolean;
    input_validation: boolean;
  };
  external: {
    no_direct_api_calls: boolean;
    no_eval: boolean;
  };
  errors: {
    no_stack_trace_exposure: boolean;
  };
}

export interface SpecConstraints {
  overrides?: Partial<{
    auth?: Partial<SpecConstraintDefaults['auth']>;
    data?: Partial<SpecConstraintDefaults['data']>;
    external?: Partial<SpecConstraintDefaults['external']>;
    errors?: Partial<SpecConstraintDefaults['errors']>;
  }>;
}

export interface SpecStack {
  language?: string;
  framework?: string;
  database?: string;
}

export interface SpecAgents {
  security_review?: boolean;
  test_generation?: boolean;
}

export interface ParsedSpec {
  daidalos: {
    version: string;
    project: string;
  };
  intent: string;
  stack?: SpecStack;
  constraints: SpecConstraintDefaults;
  agents: Required<SpecAgents>;
}

const AMBIGUOUS_PATTERNS = [
  /^APIを作りたい$/,
  /^アプリを作りたい$/,
  /^システムを作りたい$/,
  /^ちゃんと動くこと$/,
];

const CONSTRAINT_DEFAULTS: SpecConstraintDefaults = {
  auth: {
    required: true,
    public_allowed: ['/health', '/ping'],
  },
  data: {
    no_plaintext_secrets: true,
    no_sensitive_logs: true,
    input_validation: true,
  },
  external: {
    no_direct_api_calls: true,
    no_eval: true,
  },
  errors: {
    no_stack_trace_exposure: true,
  },
};

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

export function parseSpec(content: string): ParsedSpec {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (e) {
    throw new SpecParseError(`spec.yml のYAMLパースに失敗しました: ${(e as Error).message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new SpecParseError('spec.yml が空またはオブジェクト形式ではありません');
  }

  const doc = raw as Record<string, unknown>;

  if (!doc.daidalos || typeof doc.daidalos !== 'object') {
    throw new SpecParseError('daidalos フィールドが必要です');
  }

  const daidalosSection = doc.daidalos as Record<string, unknown>;

  if (!daidalosSection.version || daidalosSection.version !== '1.0') {
    throw new SpecParseError('daidalos.version は "1.0" でなければなりません');
  }

  if (!daidalosSection.project || typeof daidalosSection.project !== 'string') {
    throw new SpecParseError('daidalos.project は必須の文字列フィールドです');
  }

  if (!doc.intent || typeof doc.intent !== 'string') {
    throw new SpecParseError('intent フィールドは必須です');
  }

  const intent = doc.intent.trim();

  if (intent.length < 20) {
    throw new SpecParseError(
      `intent が短すぎます（${intent.length}文字）。20文字以上で具体的に記述してください`
    );
  }

  for (const pattern of AMBIGUOUS_PATTERNS) {
    if (pattern.test(intent)) {
      throw new SpecParseError(
        `intent が曖昧すぎます: "${intent}"\n具体的な機能・目的を記述してください`
      );
    }
  }

  const stack = parseStack(doc.stack);
  const constraints = mergeConstraints(doc.constraints as SpecConstraints | undefined);
  const agents = parseAgents(doc.agents as SpecAgents | undefined);

  return {
    daidalos: {
      version: daidalosSection.version as string,
      project: daidalosSection.project as string,
    },
    intent,
    stack,
    constraints,
    agents,
  };
}

function parseStack(raw: unknown): SpecStack | undefined {
  if (!raw) return undefined;
  if (typeof raw !== 'object') return undefined;

  const s = raw as Record<string, unknown>;
  return {
    language: typeof s.language === 'string' ? s.language : undefined,
    framework: typeof s.framework === 'string' ? s.framework : undefined,
    database: typeof s.database === 'string' ? s.database : undefined,
  };
}

function mergeConstraints(raw: SpecConstraints | undefined): SpecConstraintDefaults {
  if (!raw?.overrides) return structuredClone(CONSTRAINT_DEFAULTS);

  const merged = structuredClone(CONSTRAINT_DEFAULTS);
  const overrides = raw.overrides;

  if (overrides.auth) {
    if (overrides.auth.public_allowed) {
      merged.auth.public_allowed = overrides.auth.public_allowed;
    }
  }

  return merged;
}

function parseAgents(raw: SpecAgents | undefined): Required<SpecAgents> {
  return {
    security_review: raw?.security_review ?? true,
    test_generation: raw?.test_generation ?? true,
  };
}
