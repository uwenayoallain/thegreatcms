<script>
  import { page } from "$app/state";
</script>

<svelte:head>
  <title>Not found</title>
</svelte:head>

<section class="intro">
  <p class="kicker">{page.status}</p>
  <h1>This page was never written.</h1>
  <p class="lede"><a href="/">Read the essays that were</a></p>
</section>
