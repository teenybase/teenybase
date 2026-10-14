import {
    getCloudflareAPITokenFromEnv,
    getCloudflareGlobalAuthEmailFromEnv,
    getCloudflareGlobalAuthKeyFromEnv
} from './auth-variables'

export type ApiCredentials =
    | {
    apiToken: string;
}
    | {
    authKey: string;
    authEmail: string;
};

/**
 * Try to read API credentials from environment variables.
 *
 * Authentication priority (highest to lowest):
 * 1. Global API Key + Email (CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL)
 * 2. API Token (CLOUDFLARE_API_TOKEN)
 * 3. OAuth token from local state (via `wrangler login`) - not handled here
 *
 * Note: Global API Key + Email requires two headers (X-Auth-Key + X-Auth-Email),
 * while API Token and OAuth token are both used as Bearer tokens.
 */
export function getAuthFromEnv(): ApiCredentials | undefined {
    const globalApiKey = getCloudflareGlobalAuthKeyFromEnv();
    const globalApiEmail = getCloudflareGlobalAuthEmailFromEnv();
    const apiToken = getCloudflareAPITokenFromEnv();

    if (globalApiKey && globalApiEmail) {
        return { authKey: globalApiKey, authEmail: globalApiEmail };
    } else if (apiToken) {
        return { apiToken };
    }
}
