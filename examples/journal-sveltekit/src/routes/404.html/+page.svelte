<script>
  import Head from "#lib/Head.svelte";

  let { data } = $props();
</script>

<Head title="Not found · {data.identity.title}" description="There is no page at this address." noindex />

<section class="intro">
  <p class="kicker">404</p>
  <h1>This page was never written.</h1>
  <p class="lede"><a href="/">Read the essays that were</a></p>
</section>
