/** Preserve job-level recovery problems independently of successful sheet counts. */
import type { RenderFinished } from '../../contracts/types'
export type JobReport = Pick<RenderFinished, 'done' | 'skipped' | 'failed' | 'cancelled' | 'ms' | 'error' | 'finishingError' | 'warnings'>

export function jobIssues(report: JobReport | null): string[] {
  if (!report) return []
  const issues = [...new Set([...(report.warnings ?? []), report.finishingError, report.error].filter((value): value is string => !!value))]
  return issues.filter(issue => !issues.some(other => other !== issue && other.includes(issue)))
}

export function mayOpenRenderedSheet(results: readonly { n: number; state: string }[], n: number, cancelled: boolean): boolean {
  return !cancelled && results.some(result => result.n === n && (result.state === 'done' || result.state === 'skipped'))
}
