---
title: Forms and submissions
summary: The one thing Git cannot hold, collected in one inbox.
order: 50
---

Git cannot hold a message someone typed on your site. The studio takes it
directly, so there is no third-party form service and no per-site backend to
provision.

```html
<form method="POST" action="https://your-studio/f/{siteId}/contact">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />

  <input type="hidden" name="_redirect" value="/thanks/" />
  <input type="hidden" name="_t" value="1755024000000" />

  <button>Send</button>
</form>
```

No JavaScript is involved. Adding a site to the inbox is a row in a table.

## Reserved fields

| Field       | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `_redirect` | Where to send the visitor afterwards. Same-site paths only. |
| `_t`        | When the form was rendered, in epoch milliseconds.          |
| `company`   | Honeypot. Hide it visually _and_ from assistive technology. |

## Spam

Scored from the honeypot, the gap between render and submit, and link density —
never a CAPTCHA, which taxes every legitimate visitor to inconvenience a bot
that solves them anyway. Suspected spam is stored and hidden rather than
discarded, so nothing is lost silently.

## Limits

Each visitor address may submit 20 times a minute. Each site stores at most
1,000 submissions a day and sends at most 60 notification emails an
hour, however many addresses the traffic comes from. Past the email limit,
submissions are still stored; they just stop arriving in your mailbox until the
hour turns over.

Submissions across every site land in one inbox, with read state, CSV export,
and optional email notification.
