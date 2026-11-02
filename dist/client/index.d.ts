import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client';
export declare const inject: string[];
interface DirectorySource {
    getSnapshot(): ModelDirectoryState;
    subscribe(listener: () => void): () => void;
}
interface Injected {
    directory: DirectorySource;
}
type PlanProps = PropsRuntime<'conversation.input.dock'> & Injected;
/** Personal-use display: show the request's plan source, never account identity or status. */
export declare function PlanStatusRow(): import("react").JSX.Element;
export declare function ChatgptPlan(props: PlanProps): import("react").JSX.Element | null;
/** Register only the native display slot; no Connection or account reads are needed. */
export declare function apply(ctx: Context): void;
export {};
