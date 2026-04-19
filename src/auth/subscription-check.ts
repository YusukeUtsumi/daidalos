import * as core from '@actions/core';

export interface SubscriptionResult {
  valid: boolean;
  plan?: string;
  expiresAt?: string;
  error?: string;
}

const AUTH_SERVER_URL = process.env.DAIDALOS_AUTH_SERVER ?? 'https://auth.daidalos.dev';

export async function checkSubscription(token: string): Promise<SubscriptionResult> {
  if (process.env.DAIDALOS_MOCK_AUTH === 'true') {
    core.info('[Mock] サブスク認証をスキップします');
    return { valid: true, plan: 'mock', expiresAt: '2099-12-31' };
  }

  try {
    const response = await fetch(`${AUTH_SERVER_URL}/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        repo: process.env.GITHUB_REPOSITORY,
        run_id: process.env.GITHUB_RUN_ID,
      }),
    });

    if (response.status === 401) {
      return {
        valid: false,
        error: 'DAIDALOS_TOKEN が無効または期限切れです。サブスクリプションを確認してください',
      };
    }

    if (!response.ok) {
      return {
        valid: false,
        error: `認証サーバーエラー: HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      valid: boolean;
      plan: string;
      expires_at: string;
    };

    return {
      valid: data.valid,
      plan: data.plan,
      expiresAt: data.expires_at,
    };
  } catch (e) {
    return {
      valid: false,
      error: `認証サーバーへの接続に失敗しました: ${(e as Error).message}`,
    };
  }
}
