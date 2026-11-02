export declare const HOST_VERSION = "0.2.1-rc.2";
export declare const PROFILE = "chatgpt";
export declare const ROUTE = "openai-chatgpt";
export declare const INSTALL_MARKER = "dsh-chatgpt-subscription";
export declare class LocalSetupError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function subscriptionHome(explicit?: string): string;
export declare function assertPrivateHome(home: string): Promise<void>;
export declare function atomicWrite(path: string, value: string, mode?: number): Promise<void>;
export interface OperationLease {
    release(): Promise<void>;
    trackChild(pid: number): Promise<void>;
}
/** Keep account-changing operations out of an active DSH run, including across CLIs. */
export declare function acquireOperationLease(home: string, operation: string): Promise<OperationLease>;
export interface InstalledRuntime {
    marker: typeof INSTALL_MARKER;
    version: string;
    dshExecutable: string;
    dshRealPath: string;
    dshVersion: string;
    packageSha256: string;
    installedAt: string;
}
export declare function readInstallation(home: string): Promise<InstalledRuntime>;
export declare function assertHost(executable: string): Promise<{
    executable: string;
    realPath: string;
}>;
export declare function findDsh(explicit?: string): Promise<string>;
export declare function selectDefaultModel(home: string, modelIds: string[]): Promise<string>;
