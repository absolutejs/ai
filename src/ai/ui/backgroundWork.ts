/** Framework-neutral state for one durable task. Accounting belongs in billing,
 * not the normal progress card. Hosts derive actions from trusted saved state. */
export type BackgroundWorkCard = {
  workId: string;
  title: string;
  status:
    | "preparing"
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "unknown";
  completedSteps: number;
  totalSteps: number;
  pauseReason?: "funding" | "policy";
  fundingConfirmed?: boolean;
  hasResults: boolean;
};
export const backgroundWorkNextAction = (work: BackgroundWorkCard) => {
  if (
    !work.workId ||
    !Number.isSafeInteger(work.totalSteps) ||
    work.totalSteps < 1 ||
    !Number.isSafeInteger(work.completedSteps) ||
    work.completedSteps < 0 ||
    work.completedSteps > work.totalSteps
  )
    throw new Error("Invalid background work progress");
  if (work.status === "completed")
    return { kind: "view_results", label: "View results" } as const;
  if (work.status === "paused" && work.pauseReason === "funding")
    return work.fundingConfirmed
      ? ({ kind: "continue", label: "Continue research" } as const)
      : ({ kind: "top_up", label: "Add credits" } as const);
  if (work.status === "unknown")
    return { kind: "check_status", label: "Check status" } as const;
  if (work.hasResults)
    return { kind: "view_results", label: "View saved results" } as const;
  return { kind: "check_status", label: "Check status" } as const;
};
