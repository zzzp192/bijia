# Production deployment

The production layout keeps all mutable and authentication state outside the
container image. The application binds to `127.0.0.1:18080`; Nginx is the only
public entry point.

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
