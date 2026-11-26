<script setup lang="ts">
import { Check, Flag, MapPin } from 'lucide-vue-next'
import type { Gate } from '../../../shared/race'
import type { GateVerdict } from '../../review/lib/reachability'

const props = defineProps<{ gates: Gate[]; nextGate: number; penalty: number; verdicts?: GateVerdict[] | null }>()
const statusLabel = { confirmed: '证实', unverified: '未证实', missed: '未过' } as const
const verdictFor = (index: number) => props.verdicts?.find(v => v.gateIndex === index) ?? null
</script>

<template>
  <section class="instrument marks" aria-label="绕标裁判">
    <h2><Flag :size="17"/> 绕标裁判 <b data-testid="marks-count">{{ nextGate }} / {{ gates.length }}</b></h2>
    <ol>
      <li v-for="(gate, i) in gates" :key="gate.id" :class="{ 'with-verdict': verdictFor(i) }" :data-state="i === nextGate ? 'next' : i < nextGate ? 'cleared' : 'later'">
        <span>{{ gate.id }}</span>{{ gate.name }}
        <em v-if="verdictFor(i)" class="gate-verdict" :data-status="verdictFor(i)!.status">{{ statusLabel[verdictFor(i)!.status] }}<i v-if="verdictFor(i)!.inferred">·推断</i></em>
        <Check v-if="i < nextGate" :size="16"/><MapPin v-else-if="i === nextGate" :size="15"/><i v-else></i>
      </li>
    </ol>
    <div class="penalty">累计罚时 <output data-testid="penalty">+{{ penalty }} s</output></div>
  </section>
</template>
