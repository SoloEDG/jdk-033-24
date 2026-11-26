<script setup lang="ts">
import { computed, ref } from 'vue'
import { Compass, FileSearch, Plus, Trash2 } from 'lucide-vue-next'
import { clock, compass } from '../../../shared/format'
import { normalize } from '../../../shared/math'
import type { Course, Voyage } from '../../../shared/race'
import type { useReview } from '../model/useReview'

const props = defineProps<{ review: ReturnType<typeof useReview>; voyage: Voyage; course: Course; cursor: number; heading: number }>()
const {
  gaps, observations, showOriginal, analyses, verdicts,
  addGapAt, updateGap, removeGap, addObservation, removeObservation,
} = props.review

const headingInput = ref('')
const statusLabel = { confirmed: '证实', unverified: '未证实', missed: '未过' } as const

const analysisFor = (gapId: string) => analyses.value.find(item => item.gap.id === gapId)
const obsFor = (gapId: string) => observations.value.filter(obs => obs.gapId === gapId)
const cursorGap = computed(() => gaps.value.find(gap => props.cursor >= gap.start && props.cursor <= gap.end) ?? null)
const gate = (index: number) => props.course.gates[index]

function submitObservation(gapId: string) {
  const typed = Number(headingInput.value)
  const value = headingInput.value.trim() && Number.isFinite(typed) ? normalize(typed - 90) : props.heading
  addObservation(gapId, props.cursor, value)
  headingInput.value = ''
}
</script>

<template>
  <section class="instrument review" aria-label="证据复核">
    <h2><FileSearch :size="17"/> 证据复核 · 缺失定位</h2>
    <p class="review-hint">标出一段不可信的定位样本：只保留两端点、风况与部分舵帆输入，检验缺口内的绕标是否唯一确定。</p>
    <button type="button" class="primary review-add" @click="addGapAt(cursor)"><Plus :size="15"/> 以光标时刻新建缺口</button>

    <div v-for="gap in gaps" :key="gap.id" class="gap-card" :data-active="cursorGap?.id === gap.id || null">
      <div class="gap-head">
        <strong>缺口 {{ clock(gap.start) }} → {{ clock(gap.end) }}</strong>
        <button type="button" class="icon-button" title="删除缺口" aria-label="删除缺口" @click="removeGap(gap.id)"><Trash2 :size="15"/></button>
      </div>
      <label class="slider-label">起点 <output>{{ clock(gap.start) }}</output></label>
      <input type="range" :min="0" :max="voyage.duration" step=".1" :value="gap.start" @input="updateGap(gap.id, Number(($event.target as HTMLInputElement).value), gap.end)">
      <label class="slider-label">终点 <output>{{ clock(gap.end) }}</output></label>
      <input type="range" :min="0" :max="voyage.duration" step=".1" :value="gap.end" @input="updateGap(gap.id, gap.start, Number(($event.target as HTMLInputElement).value))">
      <p v-if="analysisFor(gap.id)" class="gap-stats">
        可行路线 {{ analysisFor(gap.id)!.accepted.length }} 条 · 被补录证据排除 {{ analysisFor(gap.id)!.excluded.length }} 条 · 保留舵帆读数 {{ analysisFor(gap.id)!.fragments }} 条
      </p>
      <div v-if="cursorGap?.id === gap.id" class="obs-editor">
        <label class="slider-label" :for="`obs-${gap.id}`"><Compass :size="13"/> 补录 {{ clock(cursor) }} 的船首向（罗盘，±10°）</label>
        <div class="obs-row">
          <input :id="`obs-${gap.id}`" v-model="headingInput" type="number" min="0" max="359" :placeholder="compass(heading)">
          <button type="button" class="primary" @click="submitObservation(gap.id)">补录</button>
        </div>
      </div>
      <ul v-if="obsFor(gap.id).length" class="obs-list">
        <li v-for="obs in obsFor(gap.id)" :key="obs.id">
          <Compass :size="13"/> {{ clock(obs.time) }} 船首 {{ compass(obs.heading) }} ±{{ obs.tolerance }}°
          <button type="button" class="icon-button" title="删除补录" aria-label="删除补录" @click="removeObservation(obs.id)"><Trash2 :size="13"/></button>
        </li>
      </ul>
    </div>
    <p v-if="!gaps.length" class="empty-note">移动播放头到可疑时刻后新建缺口；将播放头拖入缺口可查看逐时刻的可行范围。</p>
    <p v-else-if="cursorGap" class="review-hint">播放头位于缺口内：图上绿色为此时刻仍可行范围，红色为被补录证据排除的范围。</p>

    <h3 class="review-subhead">绕标判定</h3>
    <ol class="verdict-list">
      <li v-for="verdict in verdicts" :key="verdict.gateIndex" :data-status="verdict.status">
        <span class="verdict-gate">{{ gate(verdict.gateIndex).id }}</span>
        <span class="verdict-name">{{ gate(verdict.gateIndex).name }}</span>
        <b class="verdict-badge" :data-status="verdict.status">{{ statusLabel[verdict.status] }}<i v-if="verdict.inferred">·推断</i></b>
        <small>{{ verdict.note }}</small>
      </li>
    </ol>
    <p class="review-hint">后续标按所有仍可行的前序进度解释；缺口外的标以原始记录为准。</p>

    <label class="review-toggle"><input v-model="showOriginal" type="checkbox"> 显示原始记录（不可信）</label>
    <div class="legend">
      <span><i class="swatch feasible"></i>仍可行范围</span>
      <span><i class="swatch excluded"></i>已排除范围</span>
      <span><i class="swatch inferred"></i>推断路径</span>
      <span><i class="swatch original"></i>原始记录</span>
    </div>
  </section>
</template>
