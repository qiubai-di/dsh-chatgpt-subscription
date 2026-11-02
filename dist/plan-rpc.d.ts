import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import { readPlanStatus } from './plan-status.js';
type Source = Parameters<typeof readPlanStatus>[0];
/** Register only through Connection.rpc.handle, whose carrier admits/authenticates first. */
export declare function planRpcHandler(source: Source, active?: () => boolean): ConnectionRpcHandler;
export {};
