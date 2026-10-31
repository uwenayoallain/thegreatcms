<script>
  let { data } = $props();
</script>

<svelte:head>
  <title>Subscribed · {data.identity.title}</title>
</svelte:head>

<section class="intro">
  <p class="kicker">Newsletter</p>
  <h1>Thank you. The next letter is on its way to you.</h1>
  <p class="lede"><a href="/">Back to the essays</a></p>
</section>
