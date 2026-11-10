<script>
  import Head from "#lib/Head.svelte";

  let { data } = $props();
</script>

<Head title="Subscribed · {data.identity.title}" description="You are on the list for the next letter." noindex />

<section class="intro">
  <p class="kicker">Newsletter</p>
  <h1>Thank you. The next letter is on its way to you.</h1>
  <p class="lede"><a href="/">Back to the essays</a></p>
</section>
