<script setup lang="ts">
import type { Point } from '../../../shared/race'
import type { GapOverlay } from '../model/useReview'

defineProps<{ overlays: GapOverlay[] }>()

const path = (points: Point[]) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
const hullPath = (points: Point[]) => points.length > 2 ? `${path(points)} Z` : ''
const mid = (points: Point[]) => points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 }
</script>

<template>
  <g v-for="overlay in overlays" :key="overlay.gapId" class="review-layer">
    <path v-if="overlay.original.length > 1" :d="path(overlay.original)" fill="none" stroke="#f4efe0" stroke-width="1.6" stroke-dasharray="1.5 5" opacity=".55"/>
    <path v-if="overlay.inferred.length > 1" :d="path(overlay.inferred)" fill="none" stroke="#ffb44b" stroke-width="2.2" stroke-dasharray="7 5" stroke-linejoin="round" opacity=".92"/>
    <template v-if="overlay.inside">
      <path v-if="overlay.excludedHull.length > 2" :d="hullPath(overlay.excludedHull)" fill="#e77c62" fill-opacity=".2" stroke="#e77c62" stroke-width="1.4" stroke-dasharray="4 4"/>
      <path v-if="overlay.feasibleHull.length > 2" :d="hullPath(overlay.feasibleHull)" fill="#7fd4c1" fill-opacity=".26" stroke="#9fe8d6" stroke-width="1.6"/>
      <circle v-for="(p, i) in overlay.excludedDots" :key="`x${i}`" :cx="p.x" :cy="p.y" r="1.7" fill="#e77c62" opacity=".5"/>
      <circle v-for="(p, i) in overlay.feasibleDots" :key="`f${i}`" :cx="p.x" :cy="p.y" r="1.8" fill="#bff3e4" opacity=".65"/>
    </template>
    <circle :cx="overlay.from.x" :cy="overlay.from.y" r="5" fill="#213c3e" stroke="#ffb44b" stroke-width="2"/>
    <circle :cx="overlay.to.x" :cy="overlay.to.y" r="5" fill="#213c3e" stroke="#ffb44b" stroke-width="2"/>
    <text v-if="overlay.inferred.length > 1" :x="mid(overlay.inferred).x + 8" :y="mid(overlay.inferred).y - 8" fill="#ffb44b" class="water-text">推断</text>
    <text v-if="overlay.original.length > 1" :x="mid(overlay.original).x + 8" :y="mid(overlay.original).y + 16" fill="#f4efe0" opacity=".75" class="water-text">原始记录 · 不可信</text>
  </g>
</template>
