import { advanceBoat } from '../../sail/lib/dynamics'
import { windAt } from '../../wind/lib/forecast'
import { gateCrossing } from '../../jury/lib/crossing'
import { buoyPosition, gateEnds, inspectWater } from '../../chart/lib/geometry'
import { angleDelta, axis, clamp, distance, normalize, pointAt } from '../../../shared/math'
import type { Boat, Course, Gate, Point, Sample, Voyage } from '../../../shared/race'

/** 一段被标为不可信的定位样本区间（秒，相对于航次计时）。 */
export interface EvidenceGap { id: string; start: number; end: number }

/** 缺口内补录的船首向证据（内部航向角，与 Boat.heading 同约定）。 */
export interface HeadingObservation { id: string; gapId: string; time: number; heading: number; tolerance: number }

/** 一条符合船速与转向限制的候选航线。 */
export interface Particle { positions: Point[]; headings: number[]; proper: number[]; wrong: number[] }

export interface GateOutcome { proper: number; wrong: number }

export interface GapAnalysis {
  gap: EvidenceGap
  from: Sample
  to: Sample
  dt: number
  steps: number
  /** 与全部证据一致的航线 */
  accepted: Particle[]
  /** 仅被补录船首证据排除的航线 */
  excluded: Particle[]
  /** 补出的代表路径（始终视为推断） */
  inferred: Point[]
  /** 受缺口影响的标：可行航线中按指定方向过标 / 从相反侧擦过的条数 */
  outcomes: Record<number, GateOutcome>
  /** 缺口内保留的舵帆读数条数 */
  fragments: number
}

export type VerdictStatus = 'confirmed' | 'unverified' | 'missed'
export interface GateVerdict { gateIndex: number; status: VerdictStatus; inferred: boolean; note: string }

const DT = .1
const BATCH = 320
const MAX_ATTEMPTS = 1120
const TARGET_ACCEPTED = 40
const POS_TOL = 14
const HEAD_TOL = 24
const KNOTS_TOL = 5
const FRAGMENT_SPACING = 1.6
const WAYPOINT_RADIUS = 24
const GATE_DOUBT_RANGE = 260

const vicinity = (gate: Gate) => gate.width * .75 + 10
const bearingOf = (from: Point, to: Point) => normalize(Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI)

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0
  return distance(p, pointAt(a, b, t))
}

/** 缺口内只保留稀疏的舵帆读数（约每 1.6 s 一条），其余输入视为缺失。 */
function inputFragments(voyage: Voyage, t0: number, t1: number) {
  const kept: { time: number; rudder: number; sheet: number }[] = []
  let last = -Infinity
  for (const sample of voyage.samples) {
    if (sample.time <= t0 || sample.time >= t1) continue
    if (sample.time - last < FRAGMENT_SPACING) continue
    last = sample.time
    kept.push({ time: sample.time, rudder: sample.boat.rudder, sheet: sample.boat.sheet })
  }
  return kept
}

/** 记录中各标的过标时刻（mark 事件按顺序对应各门，finish 对应最后一门）。 */
export function recordedCrossings(course: Course, voyage: Voyage): (number | null)[] {
  const times: (number | null)[] = course.gates.map(() => null)
  let next = 0
  for (const event of voyage.events) {
    if (event.kind === 'mark' && next < course.gates.length) times[next++] = event.time
    else if (event.kind === 'finish') times[course.gates.length - 1] = event.time
  }
  return times
}

/** 可能受缺口影响的标：记录过标时刻落在缺口内，或缺口两端连线经过该标附近。 */
function gatesInDoubt(course: Course, crossings: (number | null)[], gap: EvidenceGap, from: Point, to: Point): number[] {
  const list: number[] = []
  course.gates.forEach((gate, index) => {
    const recorded = crossings[index]
    if (recorded !== null && recorded >= gap.start && recorded <= gap.end) { list.push(index); return }
    if (segmentDistance(gate.center, from, to) < GATE_DOUBT_RANGE) list.push(index)
  })
  return list
}

type Plan = { waypoints: Point[] }

/** 中性航线：随机绕行中点，只要求按时到达缺口终点。 */
function neutralPlan(from: Point, to: Point, rand: () => number): Plan {
  const heading = bearingOf(from, to)
  const perp = axis(heading + 90)
  const len = distance(from, to)
  const waypoints: Point[] = []
  const mids = len > 220 ? 2 : 1
  for (let i = 1; i <= mids; i++) {
    const base = pointAt(from, to, i / (mids + 1))
    const off = (rand() * 2 - 1) * (len * .3 + 26)
    waypoints.push({ x: base.x + perp.x * off, y: base.y + perp.y * off })
  }
  waypoints.push(to)
  return { waypoints }
}

/** 按指定方向过标的航线：经接近线、门线内一点，穿过门后继续向前。 */
function properPlan(gate: Gate, to: Point, rand: () => number): Plan {
  const across = axis(gate.bearing + 90)
  const waypoints: Point[] = []
  if (gate.approach) {
    const approachAcross = axis(gate.approach.bearing + 90)
    const off = (rand() * 2 - 1) * Math.max(0, gate.approach.width / 2 - 16)
    waypoints.push({ x: gate.approach.center.x + approachAcross.x * off, y: gate.approach.center.y + approachAcross.y * off })
  }
  const off = (rand() * 2 - 1) * Math.max(0, gate.width / 2 - 16)
  waypoints.push({ x: gate.center.x + across.x * off, y: gate.center.y + across.y * off })
  const ahead = axis(gate.bearing)
  waypoints.push({ x: gate.center.x + ahead.x * 46, y: gate.center.y + ahead.y * 46 })
  waypoints.push(to)
  return { waypoints }
}

/** 从相反侧擦过的航线：绕门线外端、或反向穿门，但不按指定方向过标。 */
function wrongPlan(gate: Gate, to: Point, rand: () => number): Plan {
  const forward = axis(gate.bearing)
  const across = axis(gate.bearing + 90)
  const ends = gateEnds(gate)
  const buoy = buoyPosition(gate)
  const far = ends[0] === buoy || (ends[0].x === buoy.x && ends[0].y === buoy.y) ? ends[1] : ends[0]
  const pattern = rand()
  const waypoints: Point[] = []
  if (pattern < .4) {
    const out = { x: buoy.x - gate.center.x, y: buoy.y - gate.center.y }
    const len = Math.hypot(out.x, out.y) || 1
    waypoints.push({ x: buoy.x + out.x / len * 24, y: buoy.y + out.y / len * 24 })
    waypoints.push({ x: buoy.x + out.x / len * 24 + forward.x * 60, y: buoy.y + out.y / len * 24 + forward.y * 60 })
  } else if (pattern < .8) {
    const out = { x: far.x - gate.center.x, y: far.y - gate.center.y }
    const len = Math.hypot(out.x, out.y) || 1
    waypoints.push({ x: far.x + out.x / len * 24, y: far.y + out.y / len * 24 })
    waypoints.push({ x: far.x + out.x / len * 24 + forward.x * 60, y: far.y + out.y / len * 24 + forward.y * 60 })
  } else {
    const end = rand() < .5 ? buoy : far
    const out = { x: end.x - gate.center.x, y: end.y - gate.center.y }
    const len = Math.hypot(out.x, out.y) || 1
    waypoints.push({ x: end.x + out.x / len * 24, y: end.y + out.y / len * 24 })
    const off = (rand() * 2 - 1) * gate.width * .3
    waypoints.push({ x: gate.center.x + forward.x * 42 + across.x * off, y: gate.center.y + forward.y * 42 + across.y * off })
    waypoints.push({ x: gate.center.x - forward.x * 42 + across.x * off, y: gate.center.y - forward.y * 42 + across.y * off })
  }
  waypoints.push(to)
  return { waypoints }
}

interface RunResult { status: 'ok' | 'excluded' | 'reject'; particle: Particle }

function runParticle(
  course: Course, voyage: Voyage, from: Sample, to: Sample, steps: number,
  fragments: Map<number, { rudder: number; sheet: number }>,
  observations: HeadingObservation[], doubted: number[], plan: Plan, rand: () => number,
): RunResult {
  const positions: Point[] = [{ ...from.boat.position }]
  const headings: number[] = [from.boat.heading]
  const proper = new Set<number>()
  const near = new Set<number>()
  const approached = new Set<number>()
  let boat: Boat = { ...from.boat, position: { ...from.boat.position } }
  let noise = 0
  let wpIndex = 0
  const sheetBias = (rand() - .5) * 16
  const waypoints = plan.waypoints
  const restDistance = (index: number) => {
    let total = 0
    for (let i = index; i < waypoints.length - 1; i++) total += distance(waypoints[i], waypoints[i + 1])
    return total
  }
  for (let step = 0; step < steps; step++) {
    const time = from.time + step * DT
    const wind = windAt(time, voyage.windMode)
    const fragment = fragments.get(step)
    let rudder: number, sheet: number
    if (fragment) {
      rudder = fragment.rudder
      sheet = fragment.sheet
    } else {
      while (wpIndex < waypoints.length - 1 && distance(boat.position, waypoints[wpIndex]) < WAYPOINT_RADIUS) wpIndex++
      const target = waypoints[wpIndex]
      noise = noise * .94 + (rand() - .5) * .22
      let desired = bearingOf(boat.position, target)
      const timeLeft = to.time - time
      if (wpIndex === waypoints.length - 1 && timeLeft < 1.6) {
        desired = normalize(desired + angleDelta(desired, to.boat.heading) * clamp((1.6 - timeLeft) / 1.6, 0, 1) * .7)
      }
      rudder = clamp(angleDelta(boat.heading, desired) / 26 + noise, -1, 1)
      const fromWind = Math.abs(angleDelta(boat.heading, wind.bearing))
      const preferred = clamp((fromWind - 37) * .55, 9, 78)
      const remaining = distance(boat.position, target) + restDistance(wpIndex)
      const needed = remaining / Math.max(.5, timeLeft)
      const expected = Math.max(4, boat.knots * 3.65)
      // 落后时用到最佳帆角全力追赶；超前时收帆减速消耗时间
      const slack = clamp((expected - needed) / expected, 0, 1)
      sheet = clamp(preferred + slack * 34 + (needed > expected ? 0 : sheetBias), 0, 85)
    }
    const previous = boat.position
    boat = advanceBoat({ ...boat, rudder, sheet }, wind, DT)
    if (inspectWater(course, boat.position).length) return { status: 'reject', particle: { positions, headings, proper: [], wrong: [] } }
    for (const index of doubted) {
      const gate = course.gates[index]
      if (gate.approach) {
        if (gateCrossing(gate.approach, boat.position, previous)) approached.delete(index)
        if (gateCrossing(gate.approach, previous, boat.position)) approached.add(index)
      }
      if (!proper.has(index)) {
        const hit = (!gate.approach || approached.has(index)) ? gateCrossing(gate, previous, boat.position) : null
        if (hit) proper.add(index)
      }
      if (distance(boat.position, gate.center) <= vicinity(gate)) near.add(index)
    }
    positions.push({ ...boat.position })
    headings.push(boat.heading)
  }
  const particle: Particle = {
    positions, headings,
    proper: [...proper],
    wrong: doubted.filter(index => near.has(index) && !proper.has(index)),
  }
  if (distance(boat.position, to.boat.position) > POS_TOL) return { status: 'reject', particle }
  if (Math.abs(angleDelta(boat.heading, to.boat.heading)) > HEAD_TOL) return { status: 'reject', particle }
  if (Math.abs(boat.knots - to.boat.knots) > KNOTS_TOL) return { status: 'reject', particle }
  for (const obs of observations) {
    const index = clamp(Math.round((obs.time - from.time) / DT), 0, steps)
    if (Math.abs(angleDelta(headings[index], obs.heading)) > obs.tolerance) return { status: 'excluded', particle }
  }
  return { status: 'ok', particle }
}

function pickInferred(accepted: Particle[], steps: number): Point[] {
  if (!accepted.length) return []
  const centroids: Point[] = []
  for (let i = 0; i <= steps; i++) {
    let x = 0, y = 0
    for (const p of accepted) { x += p.positions[i].x; y += p.positions[i].y }
    centroids.push({ x: x / accepted.length, y: y / accepted.length })
  }
  let best = accepted[0], bestScore = Infinity
  for (const p of accepted) {
    let score = 0
    for (let i = 0; i <= steps; i += 2) score += distance(p.positions[i], centroids[i])
    if (score < bestScore) { bestScore = score; best = p }
  }
  return best.positions
}

/**
 * 缺口可行性分析：在两端样本、风况与保留的舵帆读数约束下，
 * 采样所有符合船速与转向限制的航线，并检验补录的船首证据。
 */
export function analyzeGap(course: Course, voyage: Voyage, gap: EvidenceGap, observations: HeadingObservation[], from: Sample, to: Sample): GapAnalysis {
  const steps = Math.max(1, Math.round((to.time - from.time) / DT))
  const crossings = recordedCrossings(course, voyage)
  const doubted = gatesInDoubt(course, crossings, gap, from.boat.position, to.boat.position)
  const kept = inputFragments(voyage, gap.start, gap.end)
  const fragments = new Map(kept.map(item => [Math.round((item.time - from.time) / DT), item]))
  const rand = mulberry32(Math.round(gap.start * 10) * 100003 + Math.round(gap.end * 10) * 101 + 7)
  const accepted: Particle[] = []
  const excluded: Particle[] = []
  let attempts = 0
  while (accepted.length < TARGET_ACCEPTED && attempts < MAX_ATTEMPTS) {
    for (let b = 0; b < BATCH && attempts < MAX_ATTEMPTS; b++, attempts++) {
      const roll = rand()
      let plan: Plan
      if (!doubted.length || roll < .3) plan = neutralPlan(from.boat.position, to.boat.position, rand)
      else {
        const gate = course.gates[doubted[Math.floor(rand() * doubted.length)]]
        plan = roll < .65 ? properPlan(gate, to.boat.position, rand) : wrongPlan(gate, to.boat.position, rand)
      }
      const result = runParticle(course, voyage, from, to, steps, fragments, observations, doubted, plan, rand)
      if (result.status === 'ok') accepted.push(result.particle)
      else if (result.status === 'excluded') excluded.push(result.particle)
    }
  }
  const outcomes: Record<number, GateOutcome> = {}
  for (const index of doubted) {
    outcomes[index] = {
      proper: accepted.filter(p => p.proper.includes(index)).length,
      wrong: accepted.filter(p => p.wrong.includes(index)).length,
    }
  }
  return {
    gap, from, to, dt: DT, steps, accepted, excluded,
    inferred: pickInferred(accepted, steps),
    outcomes,
    fragments: kept.length,
  }
}

/**
 * 全航线裁判：缺口外的标以原始记录为准；缺口内的标比较两种假设的可行性。
 * 后续标不预设前序标已过，按所有仍可行的前序进度解释。
 */
export function judgeGates(course: Course, voyage: Voyage, analyses: GapAnalysis[], gaps: EvidenceGap[]): GateVerdict[] {
  const crossings = recordedCrossings(course, voyage)
  return course.gates.map((gate, gateIndex) => {
    const recorded = crossings[gateIndex]
    const inGap = recorded !== null && gaps.some(gap => recorded >= gap.start && recorded <= gap.end)
    // 缺口外的定位样本可信：记录直接证明，不做推断
    if (recorded !== null && !inGap)
      return { gateIndex, status: 'confirmed', inferred: false, note: '缺口外的原始记录直接证明' }
    const analysis = analyses.find(item => item.outcomes[gateIndex])
    const outcome = analysis?.outcomes[gateIndex]
    if (outcome && (outcome.proper > 0 || outcome.wrong > 0)) {
      if (outcome.proper > 0 && outcome.wrong > 0)
        return { gateIndex, status: 'unverified', inferred: true, note: `按指定方向过标（${outcome.proper} 条）与从相反侧擦过（${outcome.wrong} 条）的路线都可行` }
      if (outcome.proper > 0)
        return { gateIndex, status: 'confirmed', inferred: true, note: `全部 ${outcome.proper} 条可行路线均按指定方向过标` }
      return { gateIndex, status: 'missed', inferred: true, note: `可行路线均从相反侧擦过（${outcome.wrong} 条），未按指定方向过标` }
    }
    if (outcome && inGap)
      return { gateIndex, status: 'unverified', inferred: true, note: '记录称在此过标，但现有证据下的可行范围未覆盖该标' }
    if (recorded !== null)
      return { gateIndex, status: 'confirmed', inferred: false, note: '缺口外的原始记录直接证明' }
    return { gateIndex, status: 'missed', inferred: false, note: '记录中未过此标' }
  })
}

/** 凸包（单调链），用于可行范围 / 排除范围的外轮廓。 */
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return points.slice()
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}
