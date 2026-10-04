import type { ProviderEnv } from "../types.ts";
export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./types.ts";
export interface AuthResolutionOverrides {
    apiKey?: string;
    env?: ProviderEnv;
    /** Require this much remaining OAuth-token validity; defaults to five minutes. */
    minOAuthValidityMs?: number;
    signal?: AbortSignal;
}
/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export declare function resolveProviderAuth(provider: {
    id: string;
    auth: ProviderAuth;
}, credentials: CredentialStore, authContext: AuthContext, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
//# sourceMappingURL=resolve.d.ts.map