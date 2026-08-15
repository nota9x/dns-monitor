# Cloudflare Workers DNS Monitor

This was a really jank system used by hapara.fail DNS, basically it tested if the DNS service was alive and blocking specified requests whenever the URL for the monitor was called. You can do this via a cron job or a Better Stack monitor. 

It notified of downtime via a Discord webhook. Set the webhook URL in environment variables.

This isn't recommended, use proper uptime monitoring via a dedicated service.
