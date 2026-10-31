<script setup lang="ts">
import { formatDate, KINDS, type Release } from "~/composables/cms";

withDefaults(
  defineProps<{
    releases: Release[];
    headingTag?: "h2" | "h3";
  }>(),
  { headingTag: "h2" },
);
</script>

<template>
  <ol class="log" reversed>
    <li v-for="release in releases" :key="release.slug">
      <p class="when">
        <strong>{{ release.version }}</strong>
        <time :datetime="release.date">{{ formatDate(release.date) }}</time>
      </p>
      <div>
        <span v-if="release.kind" :class="['kind', release.kind]">{{ KINDS[release.kind] }}</span>
        <component :is="headingTag">
          <a :href="`/changelog/${release.slug}/`">{{ release.title }}</a>
        </component>
      </div>
    </li>
  </ol>
</template>
