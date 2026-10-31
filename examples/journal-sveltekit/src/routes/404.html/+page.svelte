<script>
  let { data } = $props();
</script>

<svelte:head>
  <title>Not found · {data.identity.title}</title>
</svelte:head>

<section class="intro">
  <p class="kicker">404</p>
  <h1>This page was never written.</h1>
  <p class="lede"><a href="/">Read the essays that were</a></p>
</section>
