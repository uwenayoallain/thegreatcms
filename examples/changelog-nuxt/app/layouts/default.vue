<script setup lang="ts">
const route = useRoute();
const cms = await useCms();
const signup = cms.identity.signup;
// A bare fragment only exists on the home page, so every page links to it there.
const signupHref = signup?.href?.startsWith("#") ? `/${signup.href}` : signup?.href;
</script>

<template>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="masthead">
    <a class="wordmark" href="/"><SunMark />{{ cms.identity.name }}</a>
    <nav aria-label="Main">
      <ul>
        <li><a href="/#pricing">Pricing</a></li>
        <li>
          <a
            href="/changelog/"
            :aria-current="route.path.startsWith('/changelog') ? 'page' : undefined"
          >
            Changelog
          </a>
        </li>
        <li v-if="signupHref" class="signup">
          <a class="button small" :href="signupHref">{{ signup?.label || "Sign up" }}</a>
        </li>
      </ul>
    </nav>
  </header>
  <main id="main"><slot /></main>
  <footer class="footer">
    <div class="footer-main">
      <a class="wordmark" href="/"><SunMark />{{ cms.identity.name }}</a>
      <p v-if="cms.identity.tagline">{{ cms.identity.tagline }}</p>
    </div>
    <details class="colophon">
      <summary>How this site is built</summary>
      <ul>
        <li>
          The product name, the home page, its pricing and its questions are edited in GreatCMS.
        </li>
        <li>Each release is a Markdown file in the repository.</li>
        <li>Nuxt generates every page as plain HTML, and no page ships any JavaScript.</li>
      </ul>
    </details>
  </footer>
</template>
