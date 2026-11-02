<script setup lang="ts">
/** Six in the morning to six at night across a half circle; the morning's focus hours are shaded. */
const cx = 160;
const cy = 170;
const r = 140;
// Rounded, because Node and the browser disagree in the last digit and Vue reports it as a hydration mismatch.
const round = (value: number) => Math.round(value * 100) / 100;
const at = (hour: number, radius: number) => {
  const angle = Math.PI * (1 - (hour - 6) / 12);
  return { x: round(cx + radius * Math.cos(angle)), y: round(cy - radius * Math.sin(angle)) };
};
const ticks = Array.from({ length: 25 }, (_, i) => 6 + i / 2).map((hour) => ({
  hour,
  major: Number.isInteger(hour),
  from: at(hour, Number.isInteger(hour) ? 118 : 126),
  to: at(hour, 134),
}));
const labels = [6, 9, 12, 15, 18].map((hour) =>
  Object.assign({ text: String(hour).padStart(2, "0") }, at(hour, 100)),
);
const [start, end] = [at(8, r - 4), at(11, r - 4)];
const focus = `M${cx} ${cy} L${start.x} ${start.y} A${r - 4} ${r - 4} 0 0 1 ${end.x} ${end.y} Z`;
const shadow = at(9.5, 96);
</script>

<template>
  <svg class="dial" viewBox="0 0 320 190" aria-hidden="true">
    <path class="face" :d="`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy} Z`" />
    <path class="focus" :d="focus" />
    <line
      v-for="tick in ticks"
      :key="tick.hour"
      :class="['tick', { minor: !tick.major }]"
      :x1="tick.from.x"
      :y1="tick.from.y"
      :x2="tick.to.x"
      :y2="tick.to.y"
    />
    <text
      v-for="label in labels"
      :key="label.text"
      :x="label.x"
      :y="label.y + 4"
      text-anchor="middle"
    >
      {{ label.text }}
    </text>
    <line class="shadow" :x1="cx" :y1="cy" :x2="shadow.x" :y2="shadow.y" />
    <line class="gnomon" :x1="cx" :y1="cy" :x2="cx + 34" :y2="cy - 64" />
  </svg>
</template>
