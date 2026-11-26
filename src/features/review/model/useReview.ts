import { computed, ref, type Ref } from 'vue'
import { clamp } from '../../../shared/math'
import type { Course, Point, Voyage } from '../../../shared/race'
import { sampleAt } from '../../logbook/lib/replay'
import {
  analyzeGap, convexHull, judgeGates,
  type EvidenceGap, type GapAnalysis, type HeadingObservation,
} from '../lib/reachability'

export interface GapOverlay {
  gapId: string
  inside: boolean
  from: Point
  to: Point
  inferred: Point[]
  original: Point[]
  feasibleHull: Point[]
  excludedHull: Point[]
  feasibleDots: Point[]
  excludedDots: Point[]
}

const MIN_GAP = 3

function sparse(points: Point[], limit = 90): Point[] {
  const step = Math.max(1, Math.ceil(points.length / limit))
  return points.filter((_, index) => index % step === 0)
}

/** 缺失证据复核：缺口、补录船首、可行性与裁判结果（练习会话内按航次保留）。 */
export function useReview(selected: Ref<Voyage | null>, cursor: Ref<number>, course: Course) {
  const gapsByVoyage = ref<Record<string, EvidenceGap[]>>({})
  const obsByVoyage = ref<Record<string, HeadingObservation[]>>({})
  const showOriginal = ref(true)

  const gaps = computed(() => selected.value ? gapsByVoyage.value[selected.value.id] ?? [] : [])
  const observations = computed(() => selected.value ? obsByVoyage.value[selected.value.id] ?? [] : [])

  function mutate(voyageId: string, gaps: EvidenceGap[], obs?: HeadingObservation[]) {
    gapsByVoyage.value = { ...gapsByVoyage.value, [voyageId]: gaps }
    if (obs) obsByVoyage.value = { ...obsByVoyage.value, [voyageId]: obs }
  }

  function addGapAt(time: number) {
    const voyage = selected.value
    if (!voyage) return
    const half = Math.min(6, Math.max(2, voyage.duration / 4))
    let start = clamp(time - half, 0, voyage.duration)
    let end = clamp(time + half, 0, voyage.duration)
    if (end - start < MIN_GAP) end = clamp(start + MIN_GAP, 0, voyage.duration)
    if (end - start < MIN_GAP) start = clamp(end - MIN_GAP, 0, voyage.duration)
    const gap: EvidenceGap = { id: crypto.randomUUID(), start, end }
    mutate(voyage.id, [...gaps.value, gap].sort((a, b) => a.start - b.start))
  }

  function updateGap(id: string, start: number, end: number) {
    const voyage = selected.value
    if (!voyage) return
    start = clamp(start, 0, voyage.duration)
    end = clamp(end, 0, voyage.duration)
    if (end - start < MIN_GAP) return
    mutate(voyage.id, gaps.value.map(gap => gap.id === id ? { ...gap, start, end } : gap))
  }

  function removeGap(id: string) {
    const voyage = selected.value
    if (!voyage) return
    mutate(voyage.id, gaps.value.filter(gap => gap.id !== id), observations.value.filter(obs => obs.gapId !== id))
  }

  function addObservation(gapId: string, time: number, heading: number) {
    const voyage = selected.value
    const gap = gaps.value.find(item => item.id === gapId)
    if (!voyage || !gap || time <= gap.start || time >= gap.end) return
    const obs: HeadingObservation = { id: crypto.randomUUID(), gapId, time, heading, tolerance: 10 }
    mutate(voyage.id, gaps.value, [...observations.value, obs])
  }

  function removeObservation(id: string) {
    const voyage = selected.value
    if (!voyage) return
    mutate(voyage.id, gaps.value, observations.value.filter(obs => obs.id !== id))
  }

  const analyses = computed<GapAnalysis[]>(() => {
    const voyage = selected.value
    if (!voyage) return []
    return gaps.value.flatMap(gap => {
      const from = sampleAt(voyage.samples, gap.start)
      const to = sampleAt(voyage.samples, gap.end)
      if (!from || !to || to.time - from.time < 1) return []
      return [analyzeGap(course, voyage, gap, observations.value.filter(obs => obs.gapId === gap.id), from, to)]
    })
  })

  const verdicts = computed(() => selected.value ? judgeGates(course, selected.value, analyses.value, gaps.value) : [])

  const overlay = computed<GapOverlay[]>(() => {
    const voyage = selected.value
    if (!voyage) return []
    return analyses.value.map(analysis => {
      const { gap } = analysis
      const inside = cursor.value >= gap.start && cursor.value <= gap.end
      const index = clamp(Math.round((clamp(cursor.value, gap.start, gap.end) - gap.start) / analysis.dt), 0, analysis.steps)
      const feasible = inside ? analysis.accepted.map(p => p.positions[index]) : []
      const excluded = inside ? analysis.excluded.map(p => p.positions[index]) : []
      return {
        gapId: gap.id,
        inside,
        from: analysis.from.boat.position,
        to: analysis.to.boat.position,
        inferred: analysis.inferred,
        original: showOriginal.value
          ? voyage.samples.filter(s => s.time >= gap.start && s.time <= gap.end).map(s => s.boat.position)
          : [],
        feasibleHull: convexHull(feasible),
        excludedHull: convexHull(excluded),
        feasibleDots: sparse(feasible),
        excludedDots: sparse(excluded),
      }
    })
  })

  return {
    gaps, observations, showOriginal, analyses, verdicts, overlay,
    addGapAt, updateGap, removeGap, addObservation, removeObservation,
  }
}
