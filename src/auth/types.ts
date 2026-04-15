export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
}

export interface CodexCredentials {
  authMode: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
}

export interface AuthConfig {
  credentialPath?: string;
  refreshCommand?: string;
  apiUrl?: string;
}
