export declare function AgentsPill({ className, onSelect }: {
    className?: string;
    /** Called with the subagent picked; by default its row is shown in the thread. */
    onSelect?: (id: string) => void;
}): import("react").JSX.Element | null;
