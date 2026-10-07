// Types shared by the Corven Connect SDK packages. They mirror the
// /connect/v1 API of the Corven backend (apps/connect-service).

export type Network = 'TESTNET' | 'MAINNET';
export type LoginMethod = 'PHONE' | 'EMAIL' | 'GOOGLE' | 'PASSKEY';
export type PhoneChannel = 'sms' | 'whatsapp' | 'call';
export type StepUpPurpose = 'sign' | 'export';
export type StepUpMethod = 'PHONE' | 'EMAIL' | 'GOOGLE' | 'PASSKEY';

export interface AppConfig {
    appId: string;
    name: string;
    logoUrl: string | null;
    loginMethods: LoginMethod[];
    googleClientId: string | null;
    networks: Network[];
    phoneChannels: PhoneChannel[];
}

export interface Identity {
    id: string;
    kind: 'PHONE' | 'EMAIL' | 'GOOGLE';
    /** Phone (E.164), email, or the Google account's email. */
    value: string | null;
    verifiedAt: string;
}

export interface Passkey {
    id: string;
    name: string | null;
    rpId: string;
    createdAt: string;
    lastUsedAt: string | null;
}

export interface WalletAddress {
    network: Network;
    address: string;
    publicKey: string;
    createdAt: string;
    exportedAt: string | null;
}

export interface User {
    id: string;
    appId: string;
    displayName: string | null;
    identities: Identity[];
    passkeys: Passkey[];
    wallets: WalletAddress[];
    createdAt: string;
}

export interface Session {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
    isNewUser?: boolean;
    user: User;
}

export interface WalletWithBalance extends WalletAddress {
    /** Shannons as a decimal string; null when the node couldn't be reached. */
    balance: string | null;
}

export interface WalletActivity {
    network: Network;
    txHash: string;
    /** Shannons leaving the wallet. */
    outflow: string;
    origin: string | null;
    createdAt: string;
}

export interface WalletsResponse {
    enabled: boolean;
    wallets: WalletWithBalance[];
    activity: WalletActivity[];
    mainnetDailyLimitCkb?: string;
}

export interface CodeSent {
    sent: true;
    channel: PhoneChannel | 'email';
    /** Masked destination, e.g. "+254 712 ••• 678". */
    to: string;
}

export interface StepUpToken {
    stepUpToken: string;
    expiresAt: string;
}

export type AuthState =
    | { status: 'loading'; user: null }
    | { status: 'signed-out'; user: null }
    | { status: 'signed-in'; user: User };

/** What the user is asked to approve when an app signs with their wallet. */
export interface SignRequest {
    network: Network;
    /** The transaction as JSON (ccc's TransactionLike). */
    transaction: unknown;
    /** Shannons leaving the wallet (inputs from it minus outputs back to it), fee included. */
    outflow: bigint;
    /** Outputs going to other addresses. */
    recipients: { address: string; capacity: bigint }[];
    fee: bigint | null;
}

export interface SignApproval {
    approved: boolean;
    /** Required on mainnet. */
    stepUpToken?: string;
}

export type ApprovalHandler = (request: SignRequest) => Promise<SignApproval>;
