import {getEnvironmentVariableFactory} from '../../workers-utils/factory'

/**
 * `CLOUDFLARE_ACCOUNT_ID` overrides the account inferred from the current user.
 */
export const getCloudflareAccountIdFromEnv = getEnvironmentVariableFactory({
    variableName: "CLOUDFLARE_ACCOUNT_ID",
    deprecatedName: "CF_ACCOUNT_ID",
});

export const getCloudflareAPITokenFromEnv = getEnvironmentVariableFactory({
    variableName: "CLOUDFLARE_API_TOKEN",
    deprecatedName: "CF_API_TOKEN",
});
export const getCloudflareGlobalAuthKeyFromEnv = getEnvironmentVariableFactory({
    variableName: "CLOUDFLARE_API_KEY",
    deprecatedName: "CF_API_KEY",
});
export const getCloudflareGlobalAuthEmailFromEnv =
    getEnvironmentVariableFactory({
        variableName: "CLOUDFLARE_EMAIL",
        deprecatedName: "CF_EMAIL",
    });
