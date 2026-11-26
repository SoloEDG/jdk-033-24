export { useReview } from './model/useReview'
export type { GapOverlay } from './model/useReview'
export {
  analyzeGap, judgeGates, convexHull, recordedCrossings,
  type EvidenceGap, type HeadingObservation, type GapAnalysis, type GateVerdict, type VerdictStatus,
} from './lib/reachability'
export { default as ReviewPanel } from './ui/ReviewPanel.vue'
export { default as ReviewLayer } from './ui/ReviewLayer.vue'
