# AGENTS.md

## Cursor Cloud specific instructions

### Visão geral

**absensiSMK** é um PWA estático (HTML/CSS/JS vanilla) para absensi digital da SMKN 1 Tana Tidung. Não há `package.json`, build step ou testes automatizados no repositório. O backend é **Supabase** (Auth, Postgres, Storage), configurado em runtime via `localStorage`.

### Serviços necessários

| Serviço | Obrigatório | Como iniciar |
|---------|-------------|--------------|
| Servidor HTTP estático | Sim | `python3 -m http.server 8080 --directory /workspace` |
| Supabase (cloud ou local) | Sim para fluxo completo | Ver seção abaixo |

Abrir `http://localhost:8080/index.html` (não usar `file://` — o service worker exige HTTP).

### Supabase local (dev/teste E2E)

Para desenvolvimento local sem credenciais cloud:

1. Docker deve estar rodando (`dockerd` — ver nota abaixo).
2. Projeto Supabase local em `/tmp/supabase-dev` (criado com `npx supabase init` + migration com tabelas `profiles`, `absensi` e bucket `foto-absensi`).
3. Iniciar: `cd /tmp/supabase-dev && npx supabase start`
4. Credenciais padrão locais:
   - URL: `http://127.0.0.1:54321`
   - Anon key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0`

**Gotcha:** A tela de setup da app exige URL com prefixo `https://`. Para Supabase local (`http://`), injete credenciais via console do navegador antes de recarregar:

```javascript
localStorage.setItem('supa_url_v2', 'http://127.0.0.1:54321');
localStorage.setItem('supa_anon_v2', '<anon-key>');
location.reload();
```

Studio local: `http://127.0.0.1:54323`

### Supabase cloud (produção)

Criar projeto em supabase.com, executar SQL de schema (tabelas `profiles`, `absensi`, bucket `foto-absensi` + políticas RLS) no SQL Editor. O README referencia SQL que **não está versionado** no repositório — inferir schema a partir de `index.html`.

### Docker no Cloud Agent

O daemon Docker não inicia via systemd neste ambiente. Após instalar Docker:

```bash
sudo dockerd > /tmp/dockerd.log 2>&1 &
sudo chmod 666 /var/run/docker.sock   # ou adicionar usuário ao grupo docker
```

Storage driver: `fuse-overlayfs` (config em `/etc/docker/daemon.json`).

### Lint / testes / build

Não há linter, suite de testes ou comando de build configurados. Validação manual:

- `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/index.html` → esperado `200`
- Testar login/registro no navegador com Supabase configurado

### Deploy

Produção via Vercel (`vercel.json` define headers para service worker). Comando local de dev: apenas o servidor HTTP estático acima.
