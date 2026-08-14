# Production deployment

The production layout keeps all mutable and authentication state outside the
container image. The application binds to `127.0.0.1:18080`, while the noVNC
browser bridge binds to `127.0.0.1:16080`; Nginx is the only public entry point.

```bash
git clone https://github.com/zzzp192/bijia.git /opt/efmat/bijia
cd /opt/efmat/bijia
docker compose -f deploy/docker-compose.prod.yml up -d --build
curl -fsS http://127.0.0.1:18080/api/health
```

Install `deploy/nginx-www.efmat.top.conf` as the Nginx site configuration,
validate with `nginx -t`, and reload Nginx. Add TLS only after the DNS origin
and Cloudflare SSL mode have been confirmed.

Persistent volumes contain SQLite history, platform cookies, browser profiles,
and 1688 state. Never publish or copy these volumes into Git.

## Remote login browser

The container starts Xvfb, Fluxbox, x11vnc, and noVNC alongside the API. A
headed marketplace login browser appears in that virtual desktop, and the web
UI embeds it through `/remote-browser/`. The bridge has no direct public port;
keep the Nginx authentication layer enabled and never expose port `16080` or
VNC port `5900` to the Internet.

Only one marketplace login helper is allowed at a time. Complete the login and
close its Chrome window before starting another platform. Cookie and profile
state is written to the persistent Docker volumes listed above.
