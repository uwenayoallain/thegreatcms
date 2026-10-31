<script setup lang="ts">
const cms = await useCms();
const { hero, features, pricing, faq } = cms;
const latest = cms.releases.slice(0, 3);
const config = useRuntimeConfig();
</script>

<template>
  <section class="hero" aria-labelledby="hero-heading">
    <div>
      <p v-if="hero.eyebrow" class="eyebrow">{{ hero.eyebrow }}</p>
      <h1 id="hero-heading">{{ hero.heading }}</h1>
      <p v-if="hero.lede" class="lede">{{ hero.lede }}</p>
      <a v-if="hero.cta?.href" class="button" :href="hero.cta.href">{{
        hero.cta.label || "Get started"
      }}</a>
    </div>
    <SunDial />
  </section>

  <section v-if="features.items?.length" aria-labelledby="features-heading">
    <h2 id="features-heading">{{ features.heading || "Features" }}</h2>
    <ul class="features">
      <li v-for="item in features.items" :key="item.title">
        <h3>{{ item.title }}</h3>
        <p v-if="item.body">{{ item.body }}</p>
      </li>
    </ul>
  </section>

  <section v-if="pricing.plans?.length" id="pricing" aria-labelledby="pricing-heading">
    <h2 id="pricing-heading">{{ pricing.heading || "Pricing" }}</h2>
    <ul class="plans">
      <li
        v-for="plan in pricing.plans"
        :key="plan.name"
        :class="['plan', { featured: plan.featured }]"
      >
        <p v-if="plan.featured" class="badge">Most people choose this</p>
        <h3>{{ plan.name }}</h3>
        <p class="price">
          {{ plan.price }}<span v-if="plan.period">{{ plan.period }}</span>
        </p>
        <ul v-if="plan.features?.length">
          <li v-for="feature in plan.features" :key="feature">{{ feature }}</li>
        </ul>
      </li>
    </ul>
  </section>

  <section v-if="faq.items?.length" class="faq" aria-labelledby="faq-heading">
    <h2 id="faq-heading">Questions</h2>
    <dl>
      <template v-for="item in faq.items" :key="item.question">
        <dt>{{ item.question }}</dt>
        <dd>{{ item.answer }}</dd>
      </template>
    </dl>
  </section>

  <section v-if="latest.length" aria-labelledby="latest-heading">
    <h2 id="latest-heading">What changed lately</h2>
    <ReleaseList :releases="latest" heading-tag="h3" />
    <a class="back" href="/changelog/">The whole changelog</a>
  </section>

  <section id="waitlist" class="waitlist" aria-labelledby="waitlist-heading">
    <h2 id="waitlist-heading">Join the beta</h2>
    <p>One email when your invitation is ready, and nothing else.</p>
    <form
      class="inline"
      method="POST"
      :action="`${config.public.cmsUrl}/f/${config.public.cmsSite}/waitlist`"
    >
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
      </div>
      <input type="hidden" name="_redirect" value="/thanks/" />
      <div class="trap" aria-hidden="true">
        <label for="website">Website</label>
        <input id="website" name="website" type="text" tabindex="-1" autocomplete="off" />
      </div>
      <button class="button" type="submit">Ask for an invitation</button>
    </form>
  </section>
</template>
